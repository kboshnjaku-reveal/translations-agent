import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export type GroupPreview = {
  bundleId: string;
  keyPath: string;
  placement: string;
  targetLocales: string[];
};

export type PromptContext = {
  bundleCount: number;
  taskCount: number;
  groupCount: number;
  queuePreview: GroupPreview[];
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
      (g, i) =>
        `  ${i + 1}. bundle=${g.bundleId} key=${g.keyPath} placement=${g.placement} → [${g.targetLocales.join(", ")}]`,
    )
    .join("\n");

  return `${role.trim()}

# Run Context

- Detected ${ctx.bundleCount} bundle(s).
- Work queue: ${ctx.groupCount} key group(s), ${ctx.taskCount} total (key × locale) task(s).
- Web validation: ${ctx.webValidationEnabled ? "ENABLED — call WebSearch for EVERY locale (required, not optional). Never skip it. Never fabricate webScore." : "DISABLED (omit webScore from score_confidence)"}.

First 5 key groups (preview):
${preview || "  (queue empty — emit_report and stop)"}

Available tools (this run): ${tools}.

${loop.trim()}

${pipeline.trim()}

${placement.trim()}

${safety.trim()}

# Termination

When \`next_key_group()\` returns \`{group: null}\`, call \`emit_report({ stats: JSON.stringify({...your-tally...}) })\` exactly once and stop responding. Do not produce any further tool calls or text.
`;
}
