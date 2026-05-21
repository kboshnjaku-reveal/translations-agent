import { randomBytes } from "node:crypto";
import { comparePlaceholders, extractPlaceholders } from "../lib/placeholders.js";
import { findMatches, type GlossaryEntry } from "../lib/glossary.js";
import { validateLocale } from "../lib/locale-validator.js";
import { scoreConfidence } from "../lib/confidence-scorer.js";
import { TraceRegistry, REQUIRED_PRE_VALIDATE, type TraceStep } from "../lib/trace.js";
import { commitBundleUpdates, type Update } from "./locale-writer.js";
import { getDeep } from "../lib/flatten-json.js";
import type { Bundle } from "./repository.js";
import type { Task, Placement } from "./work-queue.js";

// ── Shared types ───────────────────────────────────────────────────────────────

export type ServerDeps = {
  tasks: Task[];
  bundles: Bundle[];
  glossary: GlossaryEntry[];
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
};

// ── Group response shape ───────────────────────────────────────────────────────

export type KeyGroupResponse = {
  groupId: string;
  bundleId: string;
  sourceLocale: string;
  keyPath: string;
  newValue: string;
  status: "added" | "modified";
  placement: Placement;
  locales: Array<{ taskId: string; targetLocale: string }>;
};

// ── Handler input types ────────────────────────────────────────────────────────

export type NormalizeInput = { taskId: string; text: string };
export type GlossaryInput = { taskId: string; text: string; sourceLocale: string; targetLocale: string; traceToken: string };
export type ClassifyInput = { taskId: string; text: string; traceToken: string };
export type LocaleRulesInput = { taskId: string; locale: string; placement?: string | null; traceToken: string };
export type ValidateInput = {
  taskId: string;
  source: string;
  translation: string;
  locale: string;
  placeholders: Array<{ token: string; original: string }>;
  traceTokens: string[];
};
export type ScoreInput = { taskId: string; webScore?: number | null; localeScore: number; structureScore: number };
export type ReadLocaleInput = { bundleId: string; locale: string };
export type CommitBundleInput = {
  bundleId: string;
  updates: Array<{ targetLocale: string; keyPath: string; value: string; needsReview: boolean; failureReason?: string | null }>;
};
export type EmitReportInput = { stats: string };
export type TranslationMemoryInput = { taskId: string; targetLocale: string };

export type ToolHandlers = {
  nextKeyGroup: () => Promise<string>;
  normalizeText: (input: NormalizeInput) => Promise<string>;
  searchGlossary: (input: GlossaryInput) => Promise<string>;
  classifyDomain: (input: ClassifyInput) => Promise<string>;
  getLocaleRules: (input: LocaleRulesInput) => Promise<string>;
  validateTranslation: (input: ValidateInput) => Promise<string>;
  scoreConfidence: (input: ScoreInput) => Promise<string>;
  readLocaleFile: (input: ReadLocaleInput) => Promise<string>;
  commitBundle: (input: CommitBundleInput) => Promise<string>;
  emitReport: (input: EmitReportInput) => Promise<string>;
  translationMemory: (input: TranslationMemoryInput) => Promise<string>;
};

// ── Translation memory helpers ─────────────────────────────────────────────────

/**
 * Produces a compact, human-readable description of what changed between two
 * source strings at the word level. Used by the translation_memory tool to give
 * the agent a concise edit signal rather than two raw blobs to compare.
 *
 * The diff is intentionally simple (set-based, not positional) — sufficient for
 * the agent to understand which words were added or removed without needing a
 * library dependency.
 */
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

// ── Handler factory ────────────────────────────────────────────────────────────

export function makeHandlers(deps: ServerDeps): ToolHandlers {
  const trace = new TraceRegistry();
  const state = {
    translatedAuto: 0,
    flaggedForReview: 0,
    updatedFiles: new Set<string>(),
    reviewKeys: [] as ReportStats["reviewKeys"],
    reportEmitted: false,
  };
  const remaining = [...deps.tasks];
  const issuedTasks = new Map<string, Task>();
  // taskId → all member taskIds in its key group. Used so that shared steps
  // (normalize_text, classify_domain) fan their trace token out to every
  // sibling locale, satisfying validate_translation's trace check per-locale.
  const groupMembership = new Map<string, string[]>();

  const ok = (payload: unknown) => JSON.stringify(payload);
  const err = (message: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: message, ...extra });
  const requireTask = (taskId: string): Task | null => issuedTasks.get(taskId) ?? null;
  const groupOf = (taskId: string): string[] => groupMembership.get(taskId) ?? [taskId];

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

      const memberTaskIds = members.map((m) => m.taskId);
      for (const t of members) {
        issuedTasks.set(t.taskId, t);
        trace.reset(t.taskId);
        groupMembership.set(t.taskId, memberTaskIds);
      }

      const groupId = randomBytes(8).toString("hex");
      const group: KeyGroupResponse = {
        groupId,
        bundleId: first.bundleId,
        sourceLocale: first.sourceLocale,
        keyPath: first.keyPath,
        newValue: first.newValue,
        status: first.status,
        placement: first.placement,
        locales: members.map((m) => ({ taskId: m.taskId, targetLocale: m.targetLocale })),
      };

      deps.log(
        `[next_key_group] ${groupId} → ${first.bundleId}/${first.keyPath} × ${members.length} locale(s)`,
      );
      return ok({ group, remaining: others.length });
    },

    normalizeText: async ({ taskId }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId. Call next_key_group first.");
      const traceToken = trace.issueForMany(groupOf(taskId), "normalize");
      return ok({ ...task.preNormalized, traceToken });
    },

    searchGlossary: async ({ taskId, text, targetLocale, traceToken }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const matches = findMatches(deps.glossary, text, targetLocale);
      const newToken = trace.issue(taskId, "glossary");
      return ok({ matches, traceToken: newToken, priorToken: traceToken });
    },

    classifyDomain: async ({ taskId, traceToken }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const newToken = trace.issueForMany(groupOf(taskId), "classify");
      return ok({ ...task.preClassified, traceToken: newToken, priorToken: traceToken });
    },

    getLocaleRules: async ({ taskId, locale, placement, traceToken }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const base = locale.split("-")[0] ?? locale;
      const localeRules = (deps.localeRules[base] ?? deps.localeRules[locale]) as
        | Record<string, unknown>
        | undefined;
      const placementSection = (deps.localeRules.placement ?? {}) as Record<string, unknown>;
      const placementRule =
        placement && placement !== "unspecified" ? placementSection[placement] : undefined;
      const newToken = trace.issue(taskId, "locale_rules");
      return ok({
        locale,
        rules: localeRules ?? {
          formality: "Apply formal register appropriate for product UI.",
          spelling: "Use standard orthography for this locale.",
          antiPatterns: [],
          structureRules: ["Preserve placeholders exactly.", "Preserve ICU plural/select syntax."],
        },
        placementConstraint: placementRule ?? null,
        traceToken: newToken,
        priorToken: traceToken,
      });
    },

    validateTranslation: async ({ taskId, source, translation, locale, placeholders, traceTokens }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");

      const traceCheck = trace.verify(taskId, traceTokens, REQUIRED_PRE_VALIDATE as TraceStep[]);
      const issues: Array<{ code: string; expected?: string; actual?: string }> = [];

      if (!traceCheck.ok) {
        for (const missing of traceCheck.missing) {
          issues.push({ code: "MISSING_TRACE_TOKEN", expected: missing });
        }
      }

      const structureCheck = comparePlaceholders(source, translation);
      for (const m of structureCheck.missing) issues.push({ code: "PLACEHOLDER_MISSING", expected: m });
      for (const e of structureCheck.extra) issues.push({ code: "PLACEHOLDER_EXTRA", actual: e });
      if (structureCheck.reordered) issues.push({ code: "PLACEHOLDER_REORDERED" });

      const localeResult = validateLocale(translation, locale);
      for (const li of localeResult.issues) issues.push(li);

      const sourceExtracted = extractPlaceholders(source);
      const declared = placeholders.map((p) => p.original).sort();
      const found = [...sourceExtracted].sort();
      if (declared.join("|") !== found.join("|")) {
        issues.push({ code: "STRUCTURE_DIVERGED", expected: found.join(","), actual: declared.join(",") });
      }

      const structureScore = structureCheck.equal && !structureCheck.reordered ? 1 : 0;
      const localeScore = localeResult.score;
      const valid = issues.length === 0;

      const newToken = trace.issue(taskId, "validate");
      return ok({ valid, issues, structureScore, localeScore, traceToken: newToken });
    },

    scoreConfidence: async ({ taskId, webScore, localeScore, structureScore }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const result = scoreConfidence({ webScore: webScore ?? undefined, localeScore, structureScore });
      trace.issue(taskId, "score");
      return ok(result);
    },

    readLocaleFile: async ({ bundleId, locale }) => {
      const bundle = deps.bundles.find((b) => b.id === bundleId);
      if (!bundle) return err(`Unknown bundleId: ${bundleId}`);
      const target =
        bundle.targets.find((t) => t.locale === locale) ??
        (bundle.sourceLocale === locale ? bundle.sourceFile : undefined);
      if (!target) return err(`Locale ${locale} not present in bundle ${bundleId}`);
      return ok({ locale, json: target.json });
    },

    commitBundle: async ({ bundleId, updates }) => {
      const bundle = deps.bundles.find((b) => b.id === bundleId);
      if (!bundle) return err(`Unknown bundleId: ${bundleId}`);

      const sourceByKey = new Map<string, string>();
      for (const entry of bundle.sourceFile.entries) sourceByKey.set(entry.keyPath, entry.value);

      const result = await commitBundleUpdates(
        (locale) => {
          const file = bundle.targets.find((t) => t.locale === locale);
          if (!file) return undefined;
          return { absPath: file.absPath, sourceValue: undefined };
        },
        updates as Update[],
        {
          sourceByKey,
          sourceLocale: bundle.sourceLocale,
          localeWrapper: bundle.localeWrapper,
          dryRun: deps.dryRun,
        },
      );

      for (const w of result.written) state.updatedFiles.add(`${bundleId}/${w}`);
      for (const u of updates) {
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

      const finalStats: ReportStats = {
        detectedBundles: deps.bundles.length,
        sourceLocale: deps.bundles[0]?.sourceLocale ?? "en",
        targetLocales: [...targetLocales].sort(),
        changedKeys: deps.tasks.length / Math.max(targetLocales.size, 1),
        translatedAuto: state.translatedAuto,
        flaggedForReview: state.flaggedForReview,
        updatedFiles: [...state.updatedFiles].sort(),
        reviewKeys: state.reviewKeys,
      };

      deps.onReport(finalStats);
      return ok({ ok: true, summary: finalStats });
    },

    translationMemory: async ({ taskId, targetLocale }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId. Call next_key_group first.");

      // For added keys there is no prior translation to consult.
      if (task.status === "added" || task.oldValue === null) {
        return ok({ oldSource: null, oldTarget: null, sourceDiff: null });
      }

      // Look up the current on-disk translation for this key in the target locale.
      const bundle = deps.bundles.find((b) => b.id === task.bundleId);
      const targetFile = bundle?.targets.find((t) => t.locale === targetLocale);
      const oldTarget = targetFile ? (getDeep(targetFile.json, task.keyPath) ?? null) : null;

      const sourceDiff = computeSourceDiff(task.oldValue, task.newValue);

      return ok({
        oldSource: task.oldValue,
        oldTarget,
        sourceDiff,
      });
    },
  };
}
