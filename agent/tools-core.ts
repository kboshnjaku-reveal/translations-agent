import { randomBytes } from "node:crypto";
import { comparePlaceholders } from "../lib/placeholders.js";
import { validateLocale } from "../lib/locale-validator.js";
import { scoreConfidence } from "../lib/confidence-scorer.js";
import { commitBundleUpdates, type Update } from "./locale-writer.js";
import { getDeep } from "../lib/flatten-json.js";
import type { Bundle } from "./repository.js";
import type { Task, Placement } from "./work-queue.js";

// ── Shared types ───────────────────────────────────────────────────────────────

export type ServerDeps = {
  tasks: Task[];
  bundles: Bundle[];
  localeRules: Record<string, unknown>;
  webValidationEnabled: boolean;
  /**
   * When true, commit_bundle runs the server-side placeholder structure check
   * and counter updates but skips the actual disk writes. Report stats remain
   * accurate. Set from the CLI's --dry-run flag.
   */
  dryRun: boolean;
  onReport: (stats: ReportStats) => void;
  /**
   * Optional callback invoked after a key group is successfully committed.
   * Used by the checkpoint/resume feature to record completed groups.
   */
  onGroupCommitted?: (bundleId: string, keyPath: string) => Promise<void> | void;
  webSearchByTaskId?: Map<string, HtmlWebSearchEvent[]>;
  fallbackWebSearchEvents?: HtmlWebSearchEvent[];
  /**
   * When provided and webValidationEnabled is true, commitBundle calls this
   * automatically for every locale in the update — no agent tool call needed.
   */
  webSearcher?: (queries: Array<{ taskId: string; targetLocale: string; query: string }>) => Promise<void>;
  log: (msg: string) => void;
};

export type ReportStats = {
  detectedBundles: number;
  sourceLocale: string;
  targetLocales: string[];
  changedKeys: number;
  translatedAuto: number;
  flaggedForReview: number;
  updatedFiles: string[];
  reviewKeys: Array<{ bundle: string; locale: string; keyPath: string; reason?: string }>;
  htmlReport?: {
    generatedAt: string;
    groups: HtmlReportGroup[];
  };
};

export type HtmlLocaleValidation = {
  valid: boolean;
  score: number;
  issues: string[];
};

export type HtmlConfidence = {
  total: number;
  tier: "auto" | "optional" | "escalate" | "mandatory";
  webScore: number | null;
  components: {
    web: number;
    locale: number;
    structure: number;
  };
};

export type HtmlLocaleResult = {
  locale: string;
  translation: string;
  needsReview: boolean;
  failureReason?: string;
  confidence: HtmlConfidence | null;
  localeValidation: HtmlLocaleValidation | null;
  alternatives: string[];
  webValidationNote: string;
  webValidation: HtmlWebValidation;
};

export type HtmlWebSource = {
  url: string;
  title?: string;
};

export type HtmlWebSearchEvent = {
  query: string;
  targetLocale?: string;
  summary: string;
  sources: HtmlWebSource[];
};

export type HtmlWebValidation = {
  supported: boolean | null;
  sourceCount: number;
  webQueries: string[];
  webSources: HtmlWebSource[];
  summaries: string[];
  evidenceStatus: "evidence-captured" | "score-only" | "not-run";
  evidenceOrigin: "task-matched" | "none";
  scoreSource: "score_confidence_input";
  warning?: string;
  transcript: Array<{
    query: string;
    summary: string;
    sourceCount: number;
    targetLocale?: string;
  }>;
};

export type HtmlReportGroup = {
  bundleId: string;
  keyPath: string;
  sourceText: string;
  sourceLocale: string;
  status: "added" | "modified";
  placement: Placement;
  locales: HtmlLocaleResult[];
};

// ── Group response shape ───────────────────────────────────────────────────────

export type EnrichedLocale = {
  taskId: string;
  targetLocale: string;
  hint: string;
  placementConstraint: unknown | null;
  tm: { oldTarget: string | null; sourceDiff: string | null };
};

export type KeyGroupResponse = {
  groupId: string;
  bundleId: string;
  sourceLocale: string;
  keyPath: string;
  newValue: string;
  normalized: string;
  placeholders: Array<{ token: string; original: string }>;
  domain: string;
  status: "added" | "modified";
  placement: Placement;
  locales: EnrichedLocale[];
};

// ── Handler input types ────────────────────────────────────────────────────────

export type CommitBundleInput = {
  bundleId: string;
  updates: Array<{ targetLocale: string; keyPath: string; value: string; needsReview: boolean; failureReason?: string | null }>;
};

export type ToolHandlers = {
  nextKeyGroup: () => Promise<string>;
  commitBundle: (input: CommitBundleInput) => Promise<string>;
  emitReport: () => Promise<string>;
};

// ── Translation memory helper ──────────────────────────────────────────────────

function computeSourceDiff(oldSource: string, newSource: string): string {
  const tokenise = (s: string) =>
    s
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

  const oldTokens = tokenise(oldSource);
  const newTokens = tokenise(newSource);

  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);

  const removed = oldTokens.filter((t) => !newSet.has(t));
  const added = newTokens.filter((t) => !oldSet.has(t));

  const parts: string[] = [];
  if (removed.length > 0) parts.push(`removed: [${[...new Set(removed)].join(", ")}]`);
  if (added.length > 0) parts.push(`added: [${[...new Set(added)].join(", ")}]`);
  return parts.length > 0
    ? parts.join("; ")
    : "no word-level changes (reordering or punctuation only)";
}

function buildHint(rules: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof rules.formality === "string") parts.push(rules.formality);
  if (Array.isArray(rules.antiPatterns) && rules.antiPatterns.length > 0) {
    const patterns = (rules.antiPatterns as string[]).slice(0, 2).join(" ");
    parts.push(`Avoid: ${patterns}`);
  }
  return parts.join(" | ");
}

// ── Handler factory ────────────────────────────────────────────────────────────

export function makeHandlers(deps: ServerDeps): ToolHandlers {
  type TaskTelemetry = {
    localeValidation?: HtmlLocaleValidation;
    confidence?: HtmlConfidence;
  };

  type GroupAccumulator = Omit<HtmlReportGroup, "locales"> & {
    locales: Map<string, HtmlLocaleResult>;
  };

  const telemetry = new Map<string, TaskTelemetry>();
  const taskIndex = new Map<string, Task>();
  for (const task of deps.tasks) {
    taskIndex.set(`${task.bundleId}::${task.keyPath}::${task.targetLocale}`, task);
  }

  const tierToAction = (tier: HtmlConfidence["tier"]): string => {
    if (tier === "auto") return "auto-accept";
    if (tier === "optional") return "optional-review";
    if (tier === "escalate") return "escalate";
    return "mandatory-review";
  };

  const upsertTelemetry = (taskId: string, patch: Partial<TaskTelemetry>) => {
    const prev = telemetry.get(taskId) ?? {};
    telemetry.set(taskId, { ...prev, ...patch });
  };

  const buildWebValidation = (taskId: string): HtmlWebValidation => {
    const events = deps.webSearchByTaskId?.get(taskId) ?? [];
    const webQueries = [...new Set(events.map((e) => e.query))];

    const sourceMap = new Map<string, HtmlWebSource>();
    for (const event of events) {
      for (const source of event.sources) {
        if (!sourceMap.has(source.url)) {
          sourceMap.set(source.url, source);
        }
      }
    }
    const webSources = [...sourceMap.values()];
    const summaries = events.map((e) => e.summary).filter((s) => s.length > 0);
    const hasEvidence = events.length > 0;
    const evidenceStatus: "evidence-captured" | "score-only" | "not-run" = hasEvidence ? "evidence-captured" : "not-run";
    const evidenceOrigin: "task-matched" | "none" = hasEvidence ? "task-matched" : "none";
    const warning = !hasEvidence ? "WebSearch was not called for this locale — no web evidence captured." : undefined;

    const transcript = events.map((e) => ({
      query: e.query,
      summary: e.summary,
      sourceCount: e.sources.length,
      targetLocale: e.targetLocale,
    }));

    return {
      supported: hasEvidence ? webSources.length > 0 : null,
      sourceCount: webSources.length,
      webQueries,
      webSources,
      summaries,
      evidenceStatus,
      evidenceOrigin,
      scoreSource: "score_confidence_input",
      warning,
      transcript,
    };
  };

  const ensureGroup = (task: Task): GroupAccumulator => {
    const key = `${task.bundleId}::${task.keyPath}`;
    const existing = state.htmlGroups.get(key);
    if (existing) return existing;

    const created: GroupAccumulator = {
      bundleId: task.bundleId,
      keyPath: task.keyPath,
      sourceText: task.newValue,
      sourceLocale: task.sourceLocale,
      status: task.status,
      placement: task.placement,
      locales: new Map<string, HtmlLocaleResult>(),
    };
    state.htmlGroups.set(key, created);
    return created;
  };

  const state = {
    translatedAuto: 0,
    flaggedForReview: 0,
    updatedFiles: new Set<string>(),
    reviewKeys: [] as ReportStats["reviewKeys"],
    htmlGroups: new Map<string, GroupAccumulator>(),
    reportEmitted: false,
  };
  const remaining = [...deps.tasks];

  const ok = (payload: unknown) => JSON.stringify(payload);
  const err = (message: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: message, ...extra });

  return {
    nextKeyGroup: async () => {
      if (remaining.length === 0) return ok({ group: null, remaining: 0 });

      const first = remaining[0]!;
      const groupKey = `${first.bundleId}::${first.keyPath}`;
      const members: Task[] = [];
      const others: Task[] = [];
      for (const t of remaining) {
        if (`${t.bundleId}::${t.keyPath}` === groupKey) members.push(t);
        else others.push(t);
      }
      remaining.length = 0;
      remaining.push(...others);

      const groupId = randomBytes(8).toString("hex");
      const bundle = deps.bundles.find((b) => b.id === first.bundleId);
      const placementSection = (deps.localeRules.placement ?? {}) as Record<string, unknown>;
      const placementRule =
        first.placement !== "unspecified" ? placementSection[first.placement] : undefined;

      const locales: EnrichedLocale[] = members.map((m) => {
        const base = m.targetLocale.split("-")[0] ?? m.targetLocale;
        const rules = ((deps.localeRules[base] ?? deps.localeRules[m.targetLocale]) ?? {
          formality: "Apply formal register appropriate for product UI.",
          spelling: "Use standard orthography for this locale.",
          antiPatterns: [],
          structureRules: ["Preserve placeholders exactly.", "Preserve ICU plural/select syntax."],
        }) as Record<string, unknown>;

        let tm: EnrichedLocale["tm"] = { oldTarget: null, sourceDiff: null };
        if (m.status === "modified" && m.oldValue !== null) {
          const targetFile = bundle?.targets.find((t) => t.locale === m.targetLocale);
          const rawTarget = targetFile ? getDeep(targetFile.json, m.keyPath) : null;
          tm = {
            oldTarget: typeof rawTarget === "string" ? rawTarget : null,
            sourceDiff: computeSourceDiff(m.oldValue, m.newValue),
          };
        }

        return {
          taskId: m.taskId,
          targetLocale: m.targetLocale,
          hint: buildHint(rules),
          placementConstraint: placementRule ?? null,
          tm,
        };
      });

      const group: KeyGroupResponse = {
        groupId,
        bundleId: first.bundleId,
        sourceLocale: first.sourceLocale,
        keyPath: first.keyPath,
        newValue: first.newValue,
        normalized: first.preNormalized.normalized,
        placeholders: first.preNormalized.placeholders,
        domain: first.preClassified.domain,
        status: first.status,
        placement: first.placement,
        locales,
      };

      deps.log(
        `[next_key_group] ${groupId} → ${first.bundleId}/${first.keyPath} × ${members.length} locale(s)`,
      );
      return ok({ group, remaining: others.length });
    },

    commitBundle: async ({ bundleId, updates }) => {
      const bundle = deps.bundles.find((b) => b.id === bundleId);
      if (!bundle) return err(`Unknown bundleId: ${bundleId}`);

      const sourceByKey = new Map<string, string>();
      for (const entry of bundle.sourceFile.entries) sourceByKey.set(entry.keyPath, entry.value);

      // Server-side validation + scoring; override needsReview when confidence is low
      const scoredUpdates = updates.map((u) => {
        const source = sourceByKey.get(u.keyPath) ?? "";
        const structureCheck = comparePlaceholders(source, u.value);
        const localeResult = validateLocale(u.value, u.targetLocale);
        const structureScore = structureCheck.equal && !structureCheck.reordered ? 1 : 0;
        const localeScore = localeResult.score;
        const scored = scoreConfidence({ localeScore, structureScore });
        const serverForcesReview = scored.tier === "escalate" || scored.tier === "mandatory";

        const allIssues: Array<{ code: string }> = [...localeResult.issues];
        structureCheck.missing.forEach(() => allIssues.push({ code: "PLACEHOLDER_MISSING" }));
        structureCheck.extra.forEach(() => allIssues.push({ code: "PLACEHOLDER_EXTRA" }));
        if (structureCheck.reordered) allIssues.push({ code: "PLACEHOLDER_REORDERED" });

        const task = taskIndex.get(`${bundleId}::${u.keyPath}::${u.targetLocale}`);
        if (task) {
          upsertTelemetry(task.taskId, {
            localeValidation: {
              valid: allIssues.length === 0,
              score: localeScore,
              issues: allIssues.map((i) => i.code),
            },
            confidence: {
              total: scored.total,
              tier: scored.tier,
              webScore: null,
              components: scored.components,
            },
          });
        }

        return { ...u, needsReview: u.needsReview || serverForcesReview };
      });

      const result = await commitBundleUpdates(
        (locale) => {
          const file = bundle.targets.find((t) => t.locale === locale);
          if (!file) return undefined;
          return { absPath: file.absPath, sourceValue: undefined };
        },
        scoredUpdates as Update[],
        {
          sourceByKey,
          sourceLocale: bundle.sourceLocale,
          localeWrapper: bundle.localeWrapper,
          dryRun: deps.dryRun,
        },
      );

      // Run web searches for all locales before building report entries so
      // buildWebValidation finds populated results in webSearchByTaskId.
      if (deps.webSearcher) {
        const queries: Array<{ taskId: string; targetLocale: string; query: string }> = [];
        for (const u of scoredUpdates) {
          const task = taskIndex.get(`${bundleId}::${u.keyPath}::${u.targetLocale}`);
          if (task) {
            queries.push({
              taskId: task.taskId,
              targetLocale: u.targetLocale,
              query: `${u.value} ${u.targetLocale}`,
            });
          }
        }
        if (queries.length > 0) await deps.webSearcher(queries);
      }

      for (const w of result.written) state.updatedFiles.add(`${bundleId}/${w}`);
      for (const u of scoredUpdates) {
        const task = taskIndex.get(`${bundleId}::${u.keyPath}::${u.targetLocale}`);
        if (task) {
          const group = ensureGroup(task);
          const taskTelemetry = telemetry.get(task.taskId);
          group.locales.set(u.targetLocale, {
            locale: u.targetLocale,
            translation: u.value,
            needsReview: u.needsReview,
            failureReason: u.failureReason ?? undefined,
            confidence: taskTelemetry?.confidence ?? null,
            localeValidation: taskTelemetry?.localeValidation ?? null,
            alternatives: [],
            webValidationNote: "Web validation is evidence-only; results appear in the report but do not affect the confidence score.",
            webValidation: buildWebValidation(task.taskId),
          });
        }

        if (u.needsReview) {
          state.flaggedForReview += 1;
          state.reviewKeys.push({
            bundle: bundleId,
            locale: u.targetLocale,
            keyPath: u.keyPath,
            reason: u.failureReason ?? undefined,
          });
        } else {
          const rejected = result.rejected.find(
            (r) => r.keyPath === u.keyPath && r.targetLocale === u.targetLocale,
          );
          if (!rejected) state.translatedAuto += 1;
        }
      }

      const verb = deps.dryRun ? "would write" : "written";
      deps.log(
        `[commit_bundle${deps.dryRun ? " dry-run" : ""}] ${bundleId}: ${result.written.length} files ${verb}, ${result.rejected.length} rejected`,
      );

      if (deps.onGroupCommitted) {
        const uniqueKeyPaths = new Set(updates.map((u) => u.keyPath));
        for (const keyPath of uniqueKeyPaths) {
          await deps.onGroupCommitted(bundleId, keyPath);
        }
      }

      return ok(result);
    },

    emitReport: async () => {
      if (state.reportEmitted) return err("Report already emitted for this run.");
      state.reportEmitted = true;

      const targetLocales = new Set<string>();
      for (const b of deps.bundles) for (const t of b.targets) targetLocales.add(t.locale);

      const groups = [...state.htmlGroups.values()]
        .map((group) => ({
          bundleId: group.bundleId,
          keyPath: group.keyPath,
          sourceText: group.sourceText,
          sourceLocale: group.sourceLocale,
          status: group.status,
          placement: group.placement,
          locales: [...group.locales.values()]
            .sort((a, b) => a.locale.localeCompare(b.locale))
            .map((localeResult) => ({
              ...localeResult,
              confidence: localeResult.confidence
                ? {
                    ...localeResult.confidence,
                    tier: localeResult.confidence.tier,
                  }
                : null,
            })),
        }))
        .sort((a, b) => {
          const bundleCmp = a.bundleId.localeCompare(b.bundleId);
          if (bundleCmp !== 0) return bundleCmp;
          return a.keyPath.localeCompare(b.keyPath);
        });

      const finalStats: ReportStats = {
        detectedBundles: deps.bundles.length,
        sourceLocale: deps.bundles[0]?.sourceLocale ?? "en",
        targetLocales: [...targetLocales].sort(),
        changedKeys: deps.tasks.length / Math.max(targetLocales.size, 1),
        translatedAuto: state.translatedAuto,
        flaggedForReview: state.flaggedForReview,
        updatedFiles: [...state.updatedFiles].sort(),
        reviewKeys: state.reviewKeys,
        htmlReport: {
          generatedAt: new Date().toISOString(),
          groups: groups.map((group) => ({
            ...group,
            locales: group.locales.map((localeResult) => ({
              ...localeResult,
              webValidationNote: localeResult.confidence
                  ? `${localeResult.webValidationNote} action=${tierToAction(localeResult.confidence.tier)}.`
                  : localeResult.webValidationNote,
            })),
          })),
        },
      };

      deps.onReport(finalStats);
      return ok({ ok: true });
    },
  };
}
