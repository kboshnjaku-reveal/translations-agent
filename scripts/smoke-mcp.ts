import path from "node:path";
import fs from "node:fs/promises";
import { scanRepository } from "../agent/repository.js";
import { detectChangedKeys } from "../agent/git.js";
import { buildWorkQueue } from "../agent/work-queue.js";
import { buildGlossary, type LocaleEntries } from "../lib/glossary.js";
import { buildOpenAITools } from "../agent/tools-openai.js";
import { buildAnthropicServer } from "../agent/tools-anthropic.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";

const root = path.resolve(process.argv[2] ?? "fixtures/sample-repo");
const provider = (process.argv[3] ?? "openai") as "openai" | "anthropic";

async function main() {
  const bundles = await scanRepository(root);
  const changedByBundle = new Map();
  for (const b of bundles) {
    changedByBundle.set(b.id, await detectChangedKeys(root, b.sourceFile.absPath));
  }
  const tasks = buildWorkQueue({ bundles, changedByBundle });

  const localeEntries: LocaleEntries[] = [];
  const seen = new Set<string>();
  for (const b of bundles)
    for (const f of [b.sourceFile, ...b.targets]) {
      if (seen.has(f.absPath)) continue;
      seen.add(f.absPath);
      localeEntries.push({ locale: f.locale, entries: f.entries });
    }
  const glossary = buildGlossary(localeEntries, bundles[0]!.sourceLocale);

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
    glossary,
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

  const groupMap = new Map<string, { bundleId: string; keyPath: string; placement: string; targetLocales: string[] }>();
  for (const t of tasks) {
    const key = `${t.bundleId}::${t.keyPath}`;
    let entry = groupMap.get(key);
    if (!entry) {
      entry = { bundleId: t.bundleId, keyPath: t.keyPath, placement: t.placement, targetLocales: [] };
      groupMap.set(key, entry);
    }
    entry.targetLocales.push(t.targetLocale);
  }

  const prompt = await buildSystemPrompt({
    bundleCount: bundles.length,
    taskCount: tasks.length,
    groupCount: groupMap.size,
    queuePreview: [...groupMap.values()].slice(0, 5),
    webValidationEnabled: false,
    toolNames,
  });
  console.log(`\nSystem prompt: ${prompt.length} chars, ~${Math.round(prompt.length / 4)} tokens`);
  console.log(`\n----- PROMPT PREVIEW (first 1200 chars) -----`);
  console.log(prompt.slice(0, 1200));
  console.log(`\n----- END PREVIEW -----`);
}

main().catch((e) => {
  console.error(`FAIL: ${e.stack ?? e}`);
  process.exit(1);
});
