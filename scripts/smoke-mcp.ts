import path from "node:path";
import fs from "node:fs/promises";
import { scanRepository } from "../agent/repository.js";
import { detectChangedKeys } from "../agent/git.js";
import { buildWorkQueue } from "../agent/work-queue.js";
import { buildOpenAITools } from "../agent/tools-openai.js";
import { buildAnthropicServer } from "../agent/tools-anthropic.js";
import { buildGroupSystemPrompt } from "../agent/system-prompt.js";

const root = path.resolve(process.argv[2] ?? "fixtures/sample-repo");
const provider = (process.argv[3] ?? "openai") as "openai" | "anthropic";

async function main() {
  const bundles = await scanRepository(root);
  const changedByBundle = new Map();
  for (const b of bundles) {
    changedByBundle.set(b.id, await detectChangedKeys(root, b.sourceFile.absPath));
  }
  const tasks = buildWorkQueue({ bundles, changedByBundle });

  const rulesPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "data",
    "locale-rules.json",
  );
  const localeRules = JSON.parse(await fs.readFile(rulesPath, "utf8"));

  const commonDeps = {
    tasks,
    bundles,
    localeRules,
    webValidationEnabled: false,
    onReport: () => {},
    log: () => {},
  };

  let toolNames: string[];

  if (provider === "anthropic") {
    const { server, toolNames: names } = buildAnthropicServer(commonDeps);
    toolNames = names;
    console.log(`\nAnthropic MCP server built. Tools:`);
    for (const n of toolNames) console.log(`  ${n}`);
    console.log(`\nMcp server config keys: ${Object.keys(server).join(", ")}`);
  } else {
    const { tools, toolNames: names } = buildOpenAITools(commonDeps);
    toolNames = names;
    console.log(`\nOpenAI tools built (${tools.length} tools):`);
    for (const n of toolNames) console.log(`  ${n}`);
  }

  const prompt = await buildGroupSystemPrompt({ webValidationEnabled: false });
  console.log(`\nSystem prompt: ${prompt.length} chars, ~${Math.round(prompt.length / 4)} tokens`);
  console.log(`\n----- PROMPT PREVIEW (first 1200 chars) -----`);
  console.log(prompt.slice(0, 1200));
  console.log(`\n----- END PREVIEW -----`);
}

main().catch((e) => {
  console.error(`FAIL: ${e.stack ?? e}`);
  process.exit(1);
});
