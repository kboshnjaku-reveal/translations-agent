import path from "node:path";
import { scanRepository } from "../agent/repository.js";
import { ensureCleanGitState, detectChangedKeys, isGitRepo } from "../agent/git.js";
import { buildWorkQueue } from "../agent/work-queue.js";
import { buildGlossary, type LocaleEntries } from "../lib/glossary.js";

const root = path.resolve(process.argv[2] ?? "fixtures/sample-repo");

async function main() {
  console.log(`Smoke pre-flight against: ${root}\n`);

  if (!(await isGitRepo(root))) throw new Error("Not a git repo");
  await ensureCleanGitState(root);

  const bundles = await scanRepository(root);
  console.log(`Bundles: ${bundles.length}`);
  for (const b of bundles) {
    console.log(`  ${b.id}: source=${b.sourceLocale}, targets=[${b.targets.map((t) => t.locale).join(", ")}]`);
  }

  const changedByBundle = new Map<string, Awaited<ReturnType<typeof detectChangedKeys>>>();
  for (const bundle of bundles) {
    const changes = await detectChangedKeys(root, bundle.sourceFile.absPath);
    changedByBundle.set(bundle.id, changes);
    console.log(`\nChanges in ${bundle.id}: ${changes.length}`);
    for (const c of changes) {
      console.log(`  [${c.status}] ${c.keyPath}`);
      console.log(`    old: ${c.oldValue === null ? "(new key)" : JSON.stringify(c.oldValue)}`);
      console.log(`    new: ${JSON.stringify(c.newValue)}`);
    }
  }

  const tasks = buildWorkQueue({ bundles, changedByBundle });
  console.log(`\nWork queue: ${tasks.length} tasks`);
  for (const t of tasks.slice(0, 10)) {
    console.log(`  ${t.taskId.slice(0, 6)} ${t.bundleId} → ${t.targetLocale} key=${t.keyPath} placement=${t.placement}`);
  }
  if (tasks.length > 10) console.log(`  … and ${tasks.length - 10} more`);

  const entries: LocaleEntries[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles) {
    for (const f of [bundle.sourceFile, ...bundle.targets]) {
      if (seen.has(f.absPath)) continue;
      seen.add(f.absPath);
      entries.push({ locale: f.locale, entries: f.entries });
    }
  }
  const glossary = buildGlossary(entries, bundles[0]!.sourceLocale);
  console.log(`\nGlossary entries: ${glossary.length}`);
  for (const g of glossary.slice(0, 10)) {
    console.log(`  ${g.keepEnglish ? "[EN] " : ""}${g.source} → ${JSON.stringify(g.translations)}`);
  }

  console.log(`\nPre-flight OK.`);
}

main().catch((e) => {
  console.error(`FAIL: ${e.stack ?? e}`);
  process.exit(1);
});
