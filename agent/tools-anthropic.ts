import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { makeHandlers, type ServerDeps, type ReportStats } from "./tools-core.js";

export type { ServerDeps, ReportStats };

// ── Helpers ────────────────────────────────────────────────────────────────────

type AnthropicResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

function wrapResult(jsonStr: string): AnthropicResult {
  let isError = false;
  try {
    const parsed = JSON.parse(jsonStr);
    isError = typeof parsed === "object" && parsed !== null && "error" in parsed;
  } catch {
    // not JSON — treat as success text
  }
  return {
    content: [{ type: "text", text: jsonStr }],
    ...(isError ? { isError: true as const } : {}),
  };
}

// ── Tool builder ───────────────────────────────────────────────────────────────

export function buildAnthropicServer(deps: ServerDeps) {
  const h = makeHandlers(deps);

  const allTools = [
    tool(
      "next_key_group",
      "Dequeue the next key group from the work queue. A group contains one source key and every target locale that needs it translated. Returns {group, remaining} where group is null when the queue is drained. Process all locales in the group together: shared steps (normalize_text, classify_domain) run once per group; per-locale steps (search_glossary, get_locale_rules, validate_translation, score_confidence) run once per locale; commit_bundle runs once per group with batched updates.",
      {},
      async () => wrapResult(await h.nextKeyGroup()),
    ),

    tool(
      "normalize_text",
      "GROUP-SHARED. Call ONCE per key group with any member's taskId. Collapses whitespace and masks placeholders ({{x}}, {x}, ${x}, %s, %d) as __PH0__..__PHn__. The returned traceToken is valid for every locale in the group.",
      { taskId: z.string(), text: z.string() },
      async ({ taskId, text }: { taskId: string; text: string }) =>
        wrapResult(await h.normalizeText({ taskId, text })),
    ),

    tool(
      "search_glossary",
      "PER-LOCALE. Call once for each locale in the group. Looks up curated glossary terms for the given target locale. Returns matches with translations and keepEnglish flag.",
      {
        taskId: z.string(),
        text: z.string(),
        sourceLocale: z.string(),
        targetLocale: z.string(),
        traceToken: z.string(),
      },
      async ({
        taskId,
        text,
        sourceLocale,
        targetLocale,
        traceToken,
      }: {
        taskId: string;
        text: string;
        sourceLocale: string;
        targetLocale: string;
        traceToken: string;
      }) => wrapResult(await h.searchGlossary({ taskId, text, sourceLocale, targetLocale, traceToken })),
    ),

    tool(
      "classify_domain",
      "GROUP-SHARED. Call ONCE per key group with any member's taskId. Classifies the source text into a domain (eDiscovery, Legal, Tech, or general). The returned traceToken is valid for every locale in the group.",
      { taskId: z.string(), text: z.string(), traceToken: z.string() },
      async ({ taskId, text, traceToken }: { taskId: string; text: string; traceToken: string }) =>
        wrapResult(await h.classifyDomain({ taskId, text, traceToken })),
    ),

    tool(
      "get_locale_rules",
      "PER-LOCALE. Call once for each locale in the group. Fetches formality, spelling, anti-patterns, structure rules, and placement constraints for the target locale.",
      {
        taskId: z.string(),
        locale: z.string(),
        placement: z.string().optional(),
        traceToken: z.string(),
      },
      async ({
        taskId,
        locale,
        placement,
        traceToken,
      }: {
        taskId: string;
        locale: string;
        placement?: string;
        traceToken: string;
      }) => wrapResult(await h.getLocaleRules({ taskId, locale, placement, traceToken })),
    ),

    tool(
      "validate_translation",
      "Validate the candidate translation: placeholder structure equality + locale rule checks. Requires the chain of traceTokens from the prior 4 steps. Returns issues (with codes) and structureScore + localeScore. MUST be called as step 6.",
      {
        taskId: z.string(),
        source: z.string(),
        translation: z.string(),
        locale: z.string(),
        placeholders: z.array(z.object({ token: z.string(), original: z.string() })),
        traceTokens: z.array(z.string()),
      },
      async ({
        taskId,
        source,
        translation,
        locale,
        placeholders,
        traceTokens,
      }: {
        taskId: string;
        source: string;
        translation: string;
        locale: string;
        placeholders: Array<{ token: string; original: string }>;
        traceTokens: string[];
      }) =>
        wrapResult(
          await h.validateTranslation({ taskId, source, translation, locale, placeholders, traceTokens }),
        ),
    ),

    tool(
      "score_confidence",
      "Compute overall confidence from locale and structure checks only: locale*0.727 + structure*0.273. Returns {total, tier}: tier is auto (>0.95), optional (>=0.85), escalate (>=0.70), or mandatory (<0.70). MUST be called as step 8. Do NOT pass webScore — it is not used.",
      {
        taskId: z.string(),
        localeScore: z.number(),
        structureScore: z.number(),
      },
      async ({
        taskId,
        localeScore,
        structureScore,
      }: {
        taskId: string;
        localeScore: number;
        structureScore: number;
      }) => wrapResult(await h.scoreConfidence({ taskId, localeScore, structureScore })),
    ),

    tool(
      "read_locale_file",
      "Read the current content of a target locale file in a bundle (read-only). Use this to consult neighboring keys for tone/terminology consistency.",
      { bundleId: z.string(), locale: z.string() },
      async ({ bundleId, locale }: { bundleId: string; locale: string }) =>
        wrapResult(await h.readLocaleFile({ bundleId, locale })),
    ),

    tool(
      "commit_bundle",
      "Persist translation updates for a single bundle. Call ONCE per key group with one entry in `updates` for every locale you translated. The host re-runs placeholder structure checks server-side and rejects any structurally-broken updates. Updates with needsReview=true bypass the structure check and write a sibling `<keyPath>__needsReview: true` key. Use this — never use raw Write on locale JSON.",
      {
        bundleId: z.string(),
        updates: z.array(
          z.object({
            targetLocale: z.string(),
            keyPath: z.string(),
            value: z.string(),
            needsReview: z.boolean(),
            failureReason: z.string().optional(),
          }),
        ),
      },
      async ({
        bundleId,
        updates,
      }: {
        bundleId: string;
        updates: Array<{
          targetLocale: string;
          keyPath: string;
          value: string;
          needsReview: boolean;
          failureReason?: string;
        }>;
      }) => wrapResult(await h.commitBundle({ bundleId, updates })),
    ),

    tool(
      "emit_report",
      "Emit the final localization report. Call this exactly once after next_key_group returns a null group.",
      {
        stats: z
          .string()
          .describe(
            "JSON-serialized tally of the agent's translation run (call JSON.stringify on your stats object before passing).",
          ),
      },
      async ({ stats }: { stats: string }) => wrapResult(await h.emitReport({ stats })),
    ),

    tool(
      "translation_memory",
      "PER-LOCALE. Call once per locale for MODIFIED key groups (group.status === 'modified') before translating. Returns { oldSource, oldTarget, sourceDiff } where oldSource is the previous English value, oldTarget is the existing translation on disk for this locale, and sourceDiff summarises word-level changes between oldSource and newSource. Use oldTarget as the starting point and apply only the changes indicated by sourceDiff — do not retranslate from scratch. Returns all-null values for added keys (no prior translation exists).",
      { taskId: z.string(), targetLocale: z.string() },
      async ({ taskId, targetLocale }: { taskId: string; targetLocale: string }) =>
        wrapResult(await h.translationMemory({ taskId, targetLocale })),
    ),
  ];

  const toolNames = allTools.map((t) => `mcp__localizer__${t.name}`);

  const server = createSdkMcpServer({
    name: "localizer",
    version: "0.1.0",
    tools: allTools,
  });

  return { server, toolNames };
}
