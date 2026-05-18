import { z } from "zod";
import { tool } from "@openai/agents";
import { makeHandlers, type ServerDeps, type ReportStats } from "./tools-core.js";

export type { ServerDeps, ReportStats };

// ── Parameter schemas (OpenAI: nullable for optional fields since GPT may send null) ──

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

const emitReportParams = z.object({
  stats: z
    .string()
    .describe(
      "JSON-serialized tally of the agent's translation run (call JSON.stringify on your stats object before passing).",
    ),
});

// ── Tool builder ───────────────────────────────────────────────────────────────

export function buildOpenAITools(deps: ServerDeps) {
  const h = makeHandlers(deps);

  const allTools = [
    tool({
      name: "next_task",
      description:
        "Dequeue the next translation task from the work queue. Returns null when the queue is drained. Always call this before starting a new task.",
      parameters: z.object({}),
      execute: async () => h.nextTask(),
    }),

    tool({
      name: "normalize_text",
      description:
        "Normalize the source text: collapse whitespace and mask placeholders ({{x}}, {x}, ${x}, %s, %d) as __PH0__..__PHn__. MUST be called as step 1 of the pipeline.",
      parameters: normalizeParams,
      execute: async (input: z.infer<typeof normalizeParams>) => h.normalizeText(input),
    }),

    tool({
      name: "search_glossary",
      description:
        "Look up curated glossary terms in the source text for the given target locale. MUST be called as step 2. Returns matches with translations and keepEnglish flag.",
      parameters: glossaryParams,
      execute: async (input: z.infer<typeof glossaryParams>) => h.searchGlossary(input),
    }),

    tool({
      name: "classify_domain",
      description:
        "Classify the source text into a domain (eDiscovery, Legal, Tech, or general) by keyword matching. MUST be called as step 3.",
      parameters: classifyParams,
      execute: async (input: z.infer<typeof classifyParams>) => h.classifyDomain(input),
    }),

    tool({
      name: "get_locale_rules",
      description:
        "Fetch formality, spelling, anti-patterns, structure rules, and placement constraints for the target locale. MUST be called as step 4.",
      parameters: localeRulesParams,
      execute: async (input: z.infer<typeof localeRulesParams>) => h.getLocaleRules(input),
    }),

    tool({
      name: "validate_translation",
      description:
        "Validate the candidate translation: placeholder structure equality + locale rule checks. Requires the chain of traceTokens from the prior 4 steps. Returns issues (with codes) and structureScore + localeScore. MUST be called as step 6.",
      parameters: validateParams,
      execute: async (input: z.infer<typeof validateParams>) => h.validateTranslation(input),
    }),

    tool({
      name: "score_confidence",
      description:
        "Compute overall confidence: web*0.45 + locale*0.40 + structure*0.15 (or locale/structure renormalized if web omitted). Returns {total, tier}: tier is auto (>0.95), optional (>=0.85), escalate (>=0.70), or mandatory (<0.70). MUST be called as step 8.",
      parameters: scoreParams,
      execute: async (input: z.infer<typeof scoreParams>) => h.scoreConfidence(input),
    }),

    tool({
      name: "read_locale_file",
      description:
        "Read the current content of a target locale file in a bundle (read-only). Use this to consult neighboring keys for tone/terminology consistency.",
      parameters: readLocaleParams,
      execute: async (input: z.infer<typeof readLocaleParams>) => h.readLocaleFile(input),
    }),

    tool({
      name: "commit_bundle",
      description:
        "Persist translation updates for a single bundle. The host re-runs placeholder structure checks server-side and rejects any structurally-broken updates. Updates with needsReview=true bypass the structure check and write a sibling `<keyPath>__needsReview: true` key. Use this — never use raw Write on locale JSON.",
      parameters: commitBundleParams,
      execute: async (input: z.infer<typeof commitBundleParams>) => h.commitBundle(input),
    }),

    tool({
      name: "emit_report",
      description:
        "Emit the final localization report. Call this exactly once after the work queue is drained.",
      parameters: emitReportParams,
      execute: async (input: z.infer<typeof emitReportParams>) => h.emitReport(input),
    }),
  ];

  const toolNames = allTools.map((t) => t.name);
  return { tools: allTools, toolNames };
}
