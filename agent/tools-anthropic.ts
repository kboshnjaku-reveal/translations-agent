import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { makeHandlers, type ServerDeps, type ReportStats, type ToolHandlers } from "./tools-core.js";

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
  const h: ToolHandlers = makeHandlers(deps);

  const allTools = [
    tool(
      "commit_bundle",
      "Persist translation updates for a single bundle. Call ONCE per key group with one entry in `updates` for every locale you translated. The server validates placeholder structure and locale rules, scores confidence, and overrides needsReview to true when confidence is low (escalate or mandatory tier). Set needsReview=true if you have specific quality concerns; the server may also set it independently. Use this — never use raw Write on locale JSON.",
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

  ];

  const toolNames = allTools.map((t) => `mcp__localizer__${t.name}`);

  const server = createSdkMcpServer({
    name: "localizer",
    version: "0.1.0",
    tools: allTools,
  });

  return { server, toolNames, handlers: h };
}
