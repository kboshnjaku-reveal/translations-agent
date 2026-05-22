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

export async function buildGroupSystemPrompt(ctx: { webValidationEnabled: boolean }): Promise<string> {
  const [role, placement, safety] = await Promise.all([
    fs.readFile(path.join(PROMPT_DIR, "role.md"), "utf8"),
    fs.readFile(path.join(PROMPT_DIR, "placement.md"), "utf8"),
    fs.readFile(path.join(PROMPT_DIR, "safety.md"), "utf8"),
  ]);

  return `${role.trim()}

# Task

Translate every locale in the group you receive and call \`commit_bundle\` exactly once.

- Use \`group.normalized\` as working text; restore \`group.placeholders\` verbatim.
- Apply each locale's \`hint\` (formality + anti-patterns to avoid).
- Enforce \`placementConstraint\` if non-null; otherwise use the Placement Constraints below as a guide.
- For \`status === "modified"\` with non-null \`tm.oldTarget\`: update \`tm.oldTarget\` using only the changes in \`tm.sourceDiff\`. Do not retranslate from scratch.
- Set \`needsReview: true\` + short \`failureReason\` if uncertain or unable to satisfy a constraint.
- Include every locale in \`updates\` — never drop one.
- Web validation: ${ctx.webValidationEnabled ? "ENABLED — web searches run automatically server-side after you commit. No web search tool call needed from you." : "DISABLED."}.

After \`commit_bundle\` returns, stop immediately. No further tool calls or text.

${placement.trim()}

${safety.trim()}
`;
}

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
- Web validation: ${ctx.webValidationEnabled ? "ENABLED — web searches run automatically server-side when commit_bundle is called. No web search tool call needed from you. Results appear in the HTML report but do NOT affect the confidence score." : "DISABLED"}.

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
