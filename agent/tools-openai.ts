import { z } from "zod";
import { tool } from "@openai/agents";
import { makeHandlers, type ServerDeps, type ReportStats } from "./tools-core.js";

export type { ServerDeps, ReportStats };

// ── Parameter schemas (OpenAI: nullable for optional fields since GPT may send null) ──

const normalizeParams = z.object({ taskId: z.string(), text: z.string() });

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

const translationMemoryParams = z.object({
  taskId: z.string(),
  targetLocale: z.string(),
});

// ── Tool builder ───────────────────────────────────────────────────────────────

export function buildOpenAITools(deps: ServerDeps) {
  const h = makeHandlers(deps);

  const allTools = [
    tool({
      name: "next_key_group",
      description:
        "Dequeue the next key group from the work queue. A group contains one source key and every target locale that needs it translated. Returns {group, remaining} where group is null when the queue is drained. Process all locales in the group together: shared steps (normalize_text, classify_domain) run once per group; per-locale steps (get_locale_rules, validate_translation, score_confidence) run once per locale; commit_bundle runs once per group with batched updates.",
      parameters: z.object({}),
      execute: async () => h.nextKeyGroup(),
    }),

    tool({
      name: "normalize_text",
      description:
        "GROUP-SHARED. Call ONCE per key group with any member's taskId. Collapses whitespace and masks placeholders ({{x}}, {x}, ${x}, %s, %d) as __PH0__..__PHn__. The returned traceToken is valid for every locale in the group.",
      parameters: normalizeParams,
      execute: async (input: z.infer<typeof normalizeParams>) => h.normalizeText(input),
    }),

    tool({
      name: "classify_domain",
      description:
        "GROUP-SHARED. Call ONCE per key group with any member's taskId. Classifies the source text into a domain (eDiscovery, Legal, Tech, or general). The returned traceToken is valid for every locale in the group.",
      parameters: classifyParams,
      execute: async (input: z.infer<typeof classifyParams>) => h.classifyDomain(input),
    }),

    tool({
      name: "get_locale_rules",
      description:
        "PER-LOCALE. Call once for each locale in the group. Fetches formality, spelling, anti-patterns, structure rules, and placement constraints for the target locale.",
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
        "Compute overall confidence from locale and structure checks only: locale*0.727 + structure*0.273. Returns {total, tier}: tier is auto (>0.95), optional (>=0.85), escalate (>=0.70), or mandatory (<0.70). MUST be called as step 8. Do NOT pass webScore — it is not used.",
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
        "Persist translation updates for a single bundle. Call ONCE per key group with one entry in `updates` for every locale you translated. The host re-runs placeholder structure checks server-side and rejects any structurally-broken updates. Updates with needsReview=true bypass the structure check and write a sibling `<keyPath>__needsReview: true` key. Use this — never use raw Write on locale JSON.",
      parameters: commitBundleParams,
      execute: async (input: z.infer<typeof commitBundleParams>) => h.commitBundle(input),
    }),

    tool({
      name: "emit_report",
      description:
        "Emit the final localization report. Call this exactly once after next_key_group returns a null group.",
      parameters: emitReportParams,
      execute: async (input: z.infer<typeof emitReportParams>) => h.emitReport(input),
    }),

    tool({
      name: "translation_memory",
      description:
        "PER-LOCALE. Call once per locale for MODIFIED key groups (group.status === 'modified') before translating. Returns { oldSource, oldTarget, sourceDiff } where oldSource is the previous English value, oldTarget is the existing translation on disk for this locale, and sourceDiff summarises word-level changes between oldSource and newSource. Use oldTarget as the starting point and apply only the changes indicated by sourceDiff — do not retranslate from scratch. Returns all-null values for added keys (no prior translation exists).",
      parameters: translationMemoryParams,
      execute: async (input: z.infer<typeof translationMemoryParams>) => h.translationMemory(input),
    }),
  ];

  const toolNames = allTools.map((t) => t.name);
  return { tools: allTools, toolNames };
}
