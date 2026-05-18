import { z } from "zod";
import { tool } from "@openai/agents";
import {
  maskPlaceholders,
  comparePlaceholders,
  extractPlaceholders,
  normalizeWhitespace,
} from "../lib/placeholders.js";
import { findMatches, type GlossaryEntry } from "../lib/glossary.js";
import { classifyDomain } from "../lib/domain-classifier.js";
import { validateLocale } from "../lib/locale-validator.js";
import { scoreConfidence } from "../lib/confidence-scorer.js";
import { TraceRegistry, REQUIRED_PRE_VALIDATE, type TraceStep } from "../lib/trace.js";
import { commitBundleUpdates, type Update } from "./locale-writer.js";
import type { Bundle } from "./repository.js";
import type { Task } from "./work-queue.js";

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

const ok = (payload: unknown) => JSON.stringify(payload);
const err = (message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: message, ...extra });

// ── Parameter schemas ──────────────────────────────────────────────────────────

const normalizeParams = z.object({ taskId: z.string(), text: z.string() });

const glossaryParams = z.object({
  taskId: z.string(),
  text: z.string(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  traceToken: z.string(),
});

const classifyParams = z.object({ taskId: z.string(), text: z.string(), traceToken: z.string() });

const localeRulesParams = z.object({
  taskId: z.string(),
  locale: z.string(),
  placement: z.string().nullable().optional(),
  traceToken: z.string(),
});

const validateParams = z.object({
  taskId: z.string(),
  source: z.string(),
  translation: z.string(),
  locale: z.string(),
  placeholders: z.array(z.object({ token: z.string(), original: z.string() })),
  traceTokens: z.array(z.string()),
});

const scoreParams = z.object({
  taskId: z.string(),
  webScore: z.number().nullable().optional(),
  localeScore: z.number(),
  structureScore: z.number(),
});

const readLocaleParams = z.object({ bundleId: z.string(), locale: z.string() });

const commitBundleParams = z.object({
  bundleId: z.string(),
  updates: z.array(
    z.object({
      targetLocale: z.string(),
      keyPath: z.string(),
      value: z.string(),
      needsReview: z.boolean(),
      failureReason: z.string().nullable().optional(),
    }),
  ),
});

const emitReportParams = z.object({ stats: z.string().describe("JSON-serialized tally of the agent's translation run (call JSON.stringify on your stats object before passing).") });

// ── Tool factory ───────────────────────────────────────────────────────────────

export function buildMcpServer(deps: ServerDeps) {
  const trace = new TraceRegistry();
  const stats = {
    translatedAuto: 0,
    flaggedForReview: 0,
    updatedFiles: new Set<string>(),
    reviewKeys: [] as ReportStats["reviewKeys"],
    reportEmitted: false,
  };
  const remaining = [...deps.tasks];
  const issuedTasks = new Map<string, Task>();
  const requireTask = (taskId: string): Task | null => issuedTasks.get(taskId) ?? null;

  const nextTaskTool = tool({
    name: "next_task",
    description:
      "Dequeue the next translation task from the work queue. Returns null when the queue is drained. Always call this before starting a new task.",
    parameters: z.object({}),
    execute: async () => {
      const next = remaining.shift();
      if (!next) return ok({ task: null, remaining: 0 });
      issuedTasks.set(next.taskId, next);
      trace.reset(next.taskId);
      deps.log(
        `[next_task] ${next.taskId} → ${next.bundleId}/${next.targetLocale}/${next.keyPath}`,
      );
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
  });

  const normalizeTool = tool({
    name: "normalize_text",
    description:
      "Normalize the source text: collapse whitespace and mask placeholders ({{x}}, {x}, ${x}, %s, %d) as __PH0__..__PHn__. MUST be called as step 1 of the pipeline.",
    parameters: normalizeParams,
    execute: async (input: z.infer<typeof normalizeParams>) => {
      const { taskId, text } = input;
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId. Call next_task first.");
      const normalized = normalizeWhitespace(text);
      const { masked, placeholders } = maskPlaceholders(normalized);
      const traceToken = trace.issue(taskId, "normalize");
      return ok({ normalized: masked, original: normalized, placeholders, traceToken });
    },
  });

  const glossaryTool = tool({
    name: "search_glossary",
    description:
      "Look up curated glossary terms in the source text for the given target locale. MUST be called as step 2. Returns matches with translations and keepEnglish flag.",
    parameters: glossaryParams,
    execute: async (input: z.infer<typeof glossaryParams>) => {
      const { taskId, text, targetLocale, traceToken } = input;
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const matches = findMatches(deps.glossary, text, targetLocale);
      const newToken = trace.issue(taskId, "glossary");
      return ok({ matches, traceToken: newToken, priorToken: traceToken });
    },
  });

  const classifyTool = tool({
    name: "classify_domain",
    description:
      "Classify the source text into a domain (eDiscovery, Legal, Tech, or general) by keyword matching. MUST be called as step 3.",
    parameters: classifyParams,
    execute: async (input: z.infer<typeof classifyParams>) => {
      const { taskId, text, traceToken } = input;
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const result = classifyDomain(text);
      const newToken = trace.issue(taskId, "classify");
      return ok({ ...result, traceToken: newToken, priorToken: traceToken });
    },
  });

  const localeRulesTool = tool({
    name: "get_locale_rules",
    description:
      "Fetch formality, spelling, anti-patterns, structure rules, and placement constraints for the target locale. MUST be called as step 4.",
    parameters: localeRulesParams,
    execute: async (input: z.infer<typeof localeRulesParams>) => {
      const { taskId, locale, placement, traceToken } = input;
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
          structureRules: [
            "Preserve placeholders exactly.",
            "Preserve ICU plural/select syntax.",
          ],
        },
        placementConstraint: placementRule ?? null,
        traceToken: newToken,
        priorToken: traceToken,
      });
    },
  });

  const validateTool = tool({
    name: "validate_translation",
    description:
      "Validate the candidate translation: placeholder structure equality + locale rule checks. Requires the chain of traceTokens from the prior 4 steps. Returns issues (with codes) and structureScore + localeScore. MUST be called as step 6.",
    parameters: validateParams,
    execute: async (input: z.infer<typeof validateParams>) => {
      const { taskId, source, translation, locale, placeholders, traceTokens } = input;
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
      const declared = placeholders.map((p: { token: string; original: string }) => p.original).sort();
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
  });

  const scoreTool = tool({
    name: "score_confidence",
    description:
      "Compute overall confidence: web*0.45 + locale*0.40 + structure*0.15 (or locale/structure renormalized if web omitted). Returns {total, tier}: tier is auto (>0.95), optional (>=0.85), escalate (>=0.70), or mandatory (<0.70). MUST be called as step 8.",
    parameters: scoreParams,
    execute: async (input: z.infer<typeof scoreParams>) => {
      const { taskId, webScore, localeScore, structureScore } = input;
      const task = requireTask(taskId);
      if (!task) return err("Unknown taskId.");
      const result = scoreConfidence({ webScore: webScore ?? undefined, localeScore, structureScore });
      trace.issue(taskId, "score");
      return ok(result);
    },
  });

  const readLocaleTool = tool({
    name: "read_locale_file",
    description:
      "Read the current content of a target locale file in a bundle (read-only). Use this to consult neighboring keys for tone/terminology consistency.",
    parameters: readLocaleParams,
    execute: async (input: z.infer<typeof readLocaleParams>) => {
      const { bundleId, locale } = input;
      const bundle = deps.bundles.find((b) => b.id === bundleId);
      if (!bundle) return err(`Unknown bundleId: ${bundleId}`);
      const target =
        bundle.targets.find((t) => t.locale === locale) ??
        (bundle.sourceLocale === locale ? bundle.sourceFile : undefined);
      if (!target) return err(`Locale ${locale} not present in bundle ${bundleId}`);
      return ok({ locale, json: target.json });
    },
  });

  const commitBundleTool = tool({
    name: "commit_bundle",
    description:
      "Persist translation updates for a single bundle. The host re-runs placeholder structure checks server-side and rejects any structurally-broken updates. Updates with needsReview=true bypass the structure check and write a sibling `<keyPath>__needsReview: true` key. Use this — never use raw Write on locale JSON.",
    parameters: commitBundleParams,
    execute: async (input: z.infer<typeof commitBundleParams>) => {
      const { bundleId, updates } = input;
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
        { sourceByKey, sourceLocale: bundle.sourceLocale },
      );

      for (const w of result.written) stats.updatedFiles.add(`${bundleId}/${w}`);
      for (const u of updates) {
        if (u.needsReview) {
          stats.flaggedForReview += 1;
          stats.reviewKeys.push({
            bundle: bundleId,
            locale: u.targetLocale,
            keyPath: u.keyPath,
            reason: u.failureReason ?? undefined,
          });
        } else {
          const rejected = result.rejected.find(
            (r) => r.keyPath === u.keyPath && r.targetLocale === u.targetLocale,
          );
          if (!rejected) stats.translatedAuto += 1;
        }
      }

      deps.log(
        `[commit_bundle] ${bundleId}: ${result.written.length} files written, ${result.rejected.length} rejected`,
      );
      return ok(result);
    },
  });

  const emitReportTool = tool({
    name: "emit_report",
    description:
      "Emit the final localization report. Call this exactly once after the work queue is drained.",
    parameters: emitReportParams,
    execute: async (input: z.infer<typeof emitReportParams>) => {
      let agentStats: unknown;
      try { agentStats = JSON.parse(input.stats); } catch { agentStats = input.stats; }
      if (stats.reportEmitted) return err("Report already emitted for this run.");
      stats.reportEmitted = true;

      const targetLocales = new Set<string>();
      for (const b of deps.bundles) for (const t of b.targets) targetLocales.add(t.locale);

      const finalStats: ReportStats = {
        detectedBundles: deps.bundles.length,
        sourceLocale: deps.bundles[0]?.sourceLocale ?? "en",
        targetLocales: [...targetLocales].sort(),
        changedKeys: deps.tasks.length / Math.max(targetLocales.size, 1),
        translatedAuto: stats.translatedAuto,
        flaggedForReview: stats.flaggedForReview,
        updatedFiles: [...stats.updatedFiles].sort(),
        reviewKeys: stats.reviewKeys,
      };

      deps.onReport(finalStats);
      return ok({ ok: true, summary: finalStats, fromAgent: agentStats });
    },
  });

  const allTools = [
    nextTaskTool,
    normalizeTool,
    glossaryTool,
    classifyTool,
    localeRulesTool,
    validateTool,
    scoreTool,
    readLocaleTool,
    commitBundleTool,
    emitReportTool,
  ];

  const toolNames = allTools.map((t) => t.name);

  return { tools: allTools, toolNames };
}
