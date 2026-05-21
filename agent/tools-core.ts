import { comparePlaceholders, extractPlaceholders } from "../lib/placeholders.js";
import { findMatches, type GlossaryEntry } from "../lib/glossary.js";
import { validateLocale } from "../lib/locale-validator.js";
import { scoreConfidence } from "../lib/confidence-scorer.js";
import { TraceRegistry, REQUIRED_PRE_VALIDATE, type TraceStep } from "../lib/trace.js";
import { commitBundleUpdates, type Update } from "./locale-writer.js";
import type { Bundle } from "./repository.js";
import type { Task } from "./work-queue.js";

// ── Shared types ───────────────────────────────────────────────────────────────

export type ServerDeps = {
  tasks: Task[];
  bundles: Bundle[];
  glossary: GlossaryEntry[];
  localeRules: Record<string, unknown>;
  webValidationEnabled: boolean;
  onReport: (stats: ReportStats) => void;
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

export type ToolHandlers = {
  nextTask: () => Promise<string>;
  normalizeText: (input: NormalizeInput) => Promise<string>;
  searchGlossary: (input: GlossaryInput) => Promise<string>;
  classifyDomain: (input: ClassifyInput) => Promise<string>;
  getLocaleRules: (input: LocaleRulesInput) => Promise<string>;
  validateTranslation: (input: ValidateInput) => Promise<string>;
  scoreConfidence: (input: ScoreInput) => Promise<string>;
  readLocaleFile: (input: ReadLocaleInput) => Promise<string>;
  commitBundle: (input: CommitBundleInput) => Promise<string>;
  emitReport: (input: EmitReportInput) => Promise<string>;
};

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

  const ok = (payload: unknown) => JSON.stringify(payload);
  const err = (message: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: message, ...extra });
  const requireTask = (taskId: string): Task | null => issuedTasks.get(taskId) ?? null;

  return {
    nextTask: async () => {
      const next = remaining.shift();
      if (!next) return ok({ task: null, remaining: 0 });
      issuedTasks.set(next.taskId, next);
      trace.reset(next.taskId);
      deps.log(`[next_task] ${next.taskId} → ${next.bundleId}/${next.targetLocale}/${next.keyPath}`);
      return ok({
        task: {
          taskId: next.taskId,
          bundleId: next.bundleId,
          sourceLocale: next.sourceLocale,
          targetLocale: next.targetLocale,
          keyPath: next.keyPath,
          newValue: next.newValue,
          status: next.status,
          placement: next.placement,
        },
        remaining: remaining.length,
      });
    },

    normalizeText: async ({ taskId }) => {
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId. Call next_task first.");
      const traceToken = trace.issue(taskId, "normalize");
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
      const newToken = trace.issue(taskId, "classify");
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
        { sourceByKey, sourceLocale: bundle.sourceLocale, localeWrapper: bundle.localeWrapper },
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

      deps.log(
        `[commit_bundle] ${bundleId}: ${result.written.length} files written, ${result.rejected.length} rejected`,
      );
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
  };
}
