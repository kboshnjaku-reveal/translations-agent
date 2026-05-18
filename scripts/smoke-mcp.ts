import path from "node:path";
import fs from "node:fs/promises";
import { scanRepository } from "../agent/repository.js";
import { detectChangedKeys } from "../agent/git.js";
import { buildWorkQueue } from "../agent/work-queue.js";
import { buildGlossary, type LocaleEntries } from "../lib/glossary.js";
import { buildMcpServer } from "../agent/tools.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";

const root = path.resolve(process.argv[2] ?? "fixtures/sample-repo");

async function main() {
  const bundles = await scanRepository(root);
  const changedByBundle = new Map();
  for (const b of bundles) {
    changedByBundle.set(b.id, await detectChangedKeys(root, b.sourceFile.absPath));
  }
  const tasks = buildWorkQueue({ bundles, changedByBundle });

  const localeEntries: LocaleEntries[] = [];
  const seen = new Set<string>();
  for (const b of bundles) for (const f of [b.sourceFile, ...b.targets]) {
    if (seen.has(f.absPath)) continue;
    seen.add(f.absPath);
    localeEntries.push({ locale: f.locale, entries: f.entries });
  }
  const glossary = buildGlossary(localeEntries, bundles[0]!.sourceLocale);

  const rulesPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "data", "locale-rules.json");
  const localeRules = JSON.parse(await fs.readFile(rulesPath, "utf8"));

  const { server, toolNames } = buildMcpServer({
    tasks,
    bundles,
    glossary,
    localeRules,
    webValidationEnabled: false,
    onReport: () => {},
    log: () => {},
  });

  console.log("Server built. Tools:");
  for (const n of toolNames) console.log(`  ${n}`);

  const prompt = await buildSystemPrompt({
    bundleCount: bundles.length,
    taskCount: tasks.length,
    queuePreview: tasks.slice(0, 5).map((t) => ({
      taskId: t.taskId,
      bundleId: t.bundleId,
      targetLocale: t.targetLocale,
      keyPath: t.keyPath,
      placement: t.placement,
    })),
    webValidationEnabled: false,
    toolNames,
  });
  console.log(`\nSystem prompt: ${prompt.length} chars, ~${Math.round(prompt.length / 4)} tokens`);
  console.log(`\n----- PROMPT PREVIEW (first 1200 chars) -----`);
  console.log(prompt.slice(0, 1200));
  console.log(`\n----- END PREVIEW -----`);

  // Probe server instance shape minimally — confirm the config-with-instance is set
  console.log(`\nMcp server config keys: ${Object.keys(server).join(", ")}`);
}

main().catch((e) => {
  console.error(`FAIL: ${e.stack ?? e}`);
  process.exit(1);
});
