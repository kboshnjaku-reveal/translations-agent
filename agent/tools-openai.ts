import { z } from "zod";
import { tool } from "@openai/agents";
import { makeHandlers, type ServerDeps, type ReportStats } from "./tools-core.js";

export type { ServerDeps, ReportStats };

// ── Parameter schemas ──────────────────────────────────────────────────────────

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

// ── Tool builder ───────────────────────────────────────────────────────────────

export function buildOpenAITools(deps: ServerDeps) {
  const h = makeHandlers(deps);

  const allTools = [
    tool({
      name: "next_key_group",
      description:
        "Dequeue the next key group from the work queue. Returns {group, remaining} where group is null when the queue is drained. The group includes all pre-computed context: normalized source text, placeholder list, domain classification, and per-locale data (rules, placement constraints, translation memory). Process all locales in the group in a single reasoning turn, then call commit_bundle once.",
      parameters: z.object({}),
      execute: async () => h.nextKeyGroup(),
    }),

    tool({
      name: "commit_bundle",
      description:
        "Persist translation updates for a single bundle. Call ONCE per key group with one entry in `updates` for every locale you translated. The server validates placeholder structure and locale rules, scores confidence, and overrides needsReview to true when confidence is low (escalate or mandatory tier). Set needsReview=true if you have specific quality concerns; the server may also set it independently. Use this — never use raw Write on locale JSON.",
      parameters: commitBundleParams,
      execute: async (input: z.infer<typeof commitBundleParams>) => h.commitBundle(input),
    }),

    tool({
      name: "emit_report",
      description:
        "Emit the final localization report. Call this exactly once after next_key_group returns a null group.",
      parameters: z.object({}),
      execute: async () => h.emitReport(),
    }),
  ];

  const toolNames = allTools.map((t) => t.name);
  return { tools: allTools, toolNames };
}
