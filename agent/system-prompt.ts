import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export type PromptContext = {
  bundleCount: number;
  taskCount: number;
  queuePreview: Array<{ taskId: string; bundleId: string; targetLocale: string; keyPath: string; placement: string }>;
  webValidationEnabled: boolean;
  toolNames: string[];
};

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const [role, loop, pipeline, safety, placement] = await Promise.all([
    fs.readFile(path.join(PROMPT_DIR, "role.md"), "utf8"),
    fs.readFile(path.join(PROMPT_DIR, "loop.md"), "utf8"),
    fs.readFile(path.join(PROMPT_DIR, "pipeline.md"), "utf8"),
    fs.readFile(path.join(PROMPT_DIR, "safety.md"), "utf8"),
    fs.readFile(path.join(PROMPT_DIR, "placement.md"), "utf8"),
  ]);

  const tools = ctx.toolNames.join(", ");
  const preview = ctx.queuePreview
    .map(
      (t, i) =>
        `  ${i + 1}. taskId=${t.taskId} bundle=${t.bundleId} → ${t.targetLocale} key=${t.keyPath} placement=${t.placement}`,
    )
    .join("\n");

  return `${role.trim()}

# Run Context

- Detected ${ctx.bundleCount} bundle(s).
- Work queue length: ${ctx.taskCount} task(s).
- Web validation: ${ctx.webValidationEnabled ? "ENABLED (call WebSearch on ambiguous/legal content)" : "DISABLED (omit webScore from score_confidence)"}.

First 5 tasks (preview):
${preview || "  (queue empty — emit_report and stop)"}

Available tools (this run): ${tools}.

${loop.trim()}

${pipeline.trim()}

${placement.trim()}

${safety.trim()}

# Termination

When \`next_task()\` returns null, call \`emit_report({ stats: {...your-tally...} })\` exactly once and stop responding. Do not produce any further tool calls or text.
`;
}
