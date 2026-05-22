#!/usr/bin/env node
import "dotenv/config";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { scanRepository } from "./repository.js";
import { ensureCleanGitState, detectChangedKeys, isGitRepo, getHeadSha } from "./git.js";
import { loadCheckpoint, saveCheckpoint, deleteCheckpoint, isCheckpointValid, digestContents, type Checkpoint } from "../lib/checkpoint.js";
import { buildWorkQueue } from "./work-queue.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildOpenAITools } from "./tools-openai.js";
import { buildAnthropicServer } from "./tools-anthropic.js";
import { writeHtmlReport } from "./html-report.js";
import type { HtmlWebSearchEvent, ReportStats } from "./tools-core.js";
import { runBatchWebSearch } from "./web-search-batch.js";

type TokenUsage = { inputTokens: number; outputTokens: number };

// Resolved once at module load so both dev (tsx agent/index.ts) and prod
// (dist/agent/index.js) walk up to the correct asset root: repo-root in dev,
// dist/ in prod (where copy-assets.mjs mirrors data/ and prompts/).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ────────────────────────────────────────────────────────────────────────

type Provider = "openai" | "anthropic";

type Cli = {
  webValidate: boolean;
  sourceLocale?: string;
  root: string;
  model?: string;
  help: boolean;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  noResume: boolean;
  htmlReport: boolean;
};

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    webValidate: true,
    root: process.cwd(),
    help: false,
    dryRun: false,
    yes: false,
    json: false,
    noResume: false,
    htmlReport: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") cli.help = true;
    else if (a === "--no-web-validate") cli.webValidate = false;
    else if (a === "--source-locale") cli.sourceLocale = argv[++i];
    else if (a === "--root") cli.root = path.resolve(argv[++i] ?? process.cwd());
    else if (a === "--model") cli.model = argv[++i];
    else if (a === "--dry-run") cli.dryRun = true;
    else if (a === "--yes" || a === "-y") cli.yes = true;
    else if (a === "--json") cli.json = true;
    else if (a === "--no-resume") cli.noResume = true;
    else if (a === "--no-html-report") cli.htmlReport = false;
  }
  return cli;
}

function printHelp() {
  console.log(`translations-agent — repository-aware localization automation

Usage:
  translations-agent [options]

Options:
  --dry-run                   Run the full pipeline (model calls, validation, scoring) but
                              skip the final disk writes. Report stats remain accurate.
  --yes, -y                   Skip the interactive permission prompt (for CI / scripting).
  --json                      Emit the final report as JSON on stdout. Progress and tool
                              call narration are routed to stderr.
  --no-web-validate           Disable web search validation for ambiguous/legal content
  --source-locale <code>      Override source-locale auto-detection
  --root <path>               Operate on a directory other than cwd
  --model <name>              Override the model (default: gpt-4o-mini for OpenAI, claude-opus-4-7 for Anthropic)
  --no-html-report            Skip writing the HTML run report (enabled by default)
  --no-resume                 Skip loading a saved checkpoint and start from the beginning.
                              Progress is still saved for future resume unless --dry-run is set.
  --help, -h                  Show this help message

Provider selection (set one key in your .env or environment):
  OPENAI_API_KEY              Uses OpenAI agents SDK (gpt-4o)
  ANTHROPIC_API_KEY           Uses Anthropic Claude agent SDK (claude-opus-4-7)

If both keys are set, the agent will ask which provider to use at startup.

The agent must be run inside a git repository. It detects changed source-locale keys
and translates them into target locale files in the same directory.`);
}

// ── Provider detection ─────────────────────────────────────────────────────────

async function detectProvider(): Promise<Provider> {
  const hasOpenAI = !!(process.env.OPENAI_API_KEY?.trim());
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY?.trim());

  if (hasOpenAI && hasAnthropic) return askProviderChoice();
  if (hasOpenAI) return "openai";
  if (hasAnthropic) return "anthropic";

  console.error(`
ERROR: No API key found.

Set one of the following in your .env file or environment:

  OPENAI_API_KEY=<key>       → uses OpenAI agents SDK  (default model: gpt-4o-mini)
  ANTHROPIC_API_KEY=<key>    → uses Anthropic Claude SDK (default model: claude-opus-4-7)
`);
  process.exit(1);
}

async function askProviderChoice(): Promise<Provider> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nBoth OPENAI_API_KEY and ANTHROPIC_API_KEY are set.");
  console.log("  1) OpenAI    (default model: gpt-4o-mini)");
  console.log("  2) Anthropic (default model: claude-opus-4-7)");
  const answer = await new Promise<string>((resolve) =>
    rl.question("\nWhich provider should be used? Enter 1 or 2: ", resolve),
  );
  rl.close();
  const choice = answer.trim();
  if (choice === "1") return "openai";
  if (choice === "2") return "anthropic";
  console.error("Invalid choice. Please enter 1 or 2.");
  process.exit(1);
}

// ── Permission prompt ──────────────────────────────────────────────────────────

async function askPermission(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nThe agent requires:`);
  console.log(`  ✓ Read access to repository`);
  console.log(`  ✓ Write access to localization files`);
  const answer = await new Promise<string>((resolve) =>
    rl.question(`\nContinue? (y/N) `, resolve),
  );
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

// ── OpenAI execution path ──────────────────────────────────────────────────────

async function runOpenAI(opts: {
  model: string;
  systemPrompt: string;
  root: string;
  webValidate: boolean;
  taskCount: number;
  tools: import("@openai/agents").Tool[];
  webSearchByTaskId: Map<string, HtmlWebSearchEvent[]>;
  fallbackWebSearchEvents: HtmlWebSearchEvent[];
  quiet: boolean;
}): Promise<TokenUsage> {
  const { Agent, run } = await import("@openai/agents");

  const allTools = [...opts.tools];

  const agent = new Agent({
    name: "Translations Agent",
    instructions: opts.systemPrompt,
    model: opts.model,
    tools: allTools,
  });

  const maxTurns = Math.max(80, opts.taskCount * 12);
  const streamedResult = await run(agent, "Begin. Call next_task() to start.", {
    stream: true,
    maxTurns,
  });

  // In JSON mode, suppress all model narration and tool-call traces so stdout
  // stays a clean JSON document. The final report is the only stdout content.
  const out = opts.quiet ? () => {} : (s: string) => process.stdout.write(s);

  for await (const event of streamedResult) {
    if (event.type === "run_item_stream_event") {
      const item = event.item;
      if (item.type === "tool_call_item") {
        const call = item.rawItem as { name?: string };
        if (call.name) out(`  → [tool] ${call.name}\n`);
      } else if (item.type === "message_output_item") {
        const content = (item.rawItem as { content?: Array<{ type: string; text?: string }> }).content ?? [];
        for (const block of content) {
          if (block.type === "output_text" && block.text) {
            out(block.text);
          }
        }
      }
    }
  }

  const finalOutput = streamedResult.finalOutput;
  if (finalOutput && typeof finalOutput === "string" && finalOutput.trim()) {
    out(finalOutput + "\n");
  } else {
    out("\n");
  }

  // rawResponses accumulates one ModelResponse per agent turn, each with camelCase usage fields.
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const r of (streamedResult as any).rawResponses ?? []) {
    usage.inputTokens += r.usage?.inputTokens ?? 0;
    usage.outputTokens += r.usage?.outputTokens ?? 0;
  }
  return usage;
}

// ── Anthropic execution path ───────────────────────────────────────────────────

async function runAnthropic(opts: {
  model: string;
  systemPrompt: string;
  root: string;
  webValidate: boolean;
  taskCount: number;
  server: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance;
  toolNames: string[];
  webSearchByTaskId: Map<string, HtmlWebSearchEvent[]>;
  fallbackWebSearchEvents: HtmlWebSearchEvent[];
  quiet: boolean;
}): Promise<TokenUsage> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const maxTurns = Math.max(80, opts.taskCount * 12);

  const q = query({
    prompt: "Begin. Call next_task() to start.",
    options: {
      cwd: opts.root,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      mcpServers: { localizer: opts.server },
      allowedTools: opts.toolNames,
      maxTurns,
    },
  });

  const out = opts.quiet ? () => {} : (s: string) => process.stdout.write(s);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for await (const message of q) {
    if (message.type === "assistant") {
      const blocks = (message.message as { content: Array<{ type: string; text?: string; name?: string }> }).content;
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          out(block.text);
        } else if (block.type === "tool_use" && block.name) {
          out(`  → [tool] ${block.name}\n`);
        }
      }
    } else if (message.type === "result") {
      // result message carries aggregate camelCase usage for the entire run.
      const r = message as any;
      usage.inputTokens = r.usage?.inputTokens ?? usage.inputTokens;
      usage.outputTokens = r.usage?.outputTokens ?? usage.outputTokens;
      if (message.subtype === "success") {
        if (!opts.quiet) console.log("\n");
      } else {
        // Errors always go to stderr regardless of mode.
        console.error(`\nAgent ended with: ${message.subtype}`);
      }
      break;
    }
  }

  return usage;
}

// ── Token usage ledger ────────────────────────────────────────────────────────

type UsageLedger = {
  totalInputTokens: number;
  totalOutputTokens: number;
  runs: number;
  lastUpdated: string;
};

async function updateTokenLedger(root: string, run: TokenUsage): Promise<UsageLedger> {
  const ledgerPath = path.join(root, ".translations-agent-usage.json");
  let ledger: UsageLedger = { totalInputTokens: 0, totalOutputTokens: 0, runs: 0, lastUpdated: "" };
  try {
    ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as UsageLedger;
  } catch {
    // first run — start from zero
  }
  ledger.totalInputTokens += run.inputTokens;
  ledger.totalOutputTokens += run.outputTokens;
  ledger.runs += 1;
  ledger.lastUpdated = new Date().toISOString();
  await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  return ledger;
}

// ── Report ─────────────────────────────────────────────────────────────────────

function printReport(r: ReportStats) {
  console.log(`\nLocalization Agent Complete\n`);
  console.log(`Detected:`);
  console.log(`- ${r.detectedBundles} bundle${r.detectedBundles === 1 ? "" : "s"}`);
  console.log(`- source locale: ${r.sourceLocale}`);
  console.log(`- target locales: ${r.targetLocales.join(", ")}`);
  console.log(`\nChanges:`);
  console.log(`- ${r.changedKeys} changed key${r.changedKeys === 1 ? "" : "s"}`);
  console.log(`- ${r.translatedAuto} translated automatically`);
  console.log(`- ${r.flaggedForReview} flagged for review`);
  console.log(`\nUpdated:`);
  for (const f of r.updatedFiles) console.log(`- ${f}`);
  if (r.reviewKeys.length > 0) {
    console.log(`\nReview Required:`);
    for (const k of r.reviewKeys)
      console.log(`- ${k.bundle}/${k.locale}: ${k.keyPath}${k.reason ? ` (${k.reason})` : ""}`);
  }
  console.log(`\nExecution finished successfully.`);
  console.log(`Run the agent again after future repository changes.`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  // In --json mode, stdout is reserved for the final JSON report. Every other
  // human-readable line (banner, pre-flight progress, tool-call narration,
  // per-bundle commit logs) routes through `info`, which targets stderr in
  // JSON mode and stdout otherwise.
  const info = cli.json
    ? (msg: string) => process.stderr.write(msg + "\n")
    : (msg: string) => process.stdout.write(msg + "\n");

  const provider = await detectProvider();
  const model = cli.model ?? (provider === "openai" ? "gpt-4o-mini" : "claude-opus-4-7");

  info(`translations-agent  [provider: ${provider}, model: ${model}${cli.dryRun ? ", DRY-RUN" : ""}]`);
  info(`Root: ${cli.root}`);

  if (!(await isGitRepo(cli.root))) {
    console.error(`ERROR: ${cli.root} is not a git repository.`);
    process.exit(1);
  }

  if (!cli.yes) {
    const proceed = await askPermission();
    if (!proceed) {
      info("Aborted.");
      process.exit(1);
    }
  }

  info("\n→ Pre-flight: scanning repository, diffing source locale, building work queue…");

  try {
    await ensureCleanGitState(cli.root);
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  }

  let bundles;
  try {
    bundles = await scanRepository(cli.root, cli.sourceLocale);
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  }

  if (bundles.length === 0) {
    info("No locale bundles detected. Exiting.");
    process.exit(0);
  }

  info(`  Detected ${bundles.length} bundle(s):`);
  for (const b of bundles) {
    info(
      `    ${b.id}: source=${b.sourceLocale}, targets=[${b.targets.map((t) => t.locale).join(", ")}]`,
    );
  }

  const changedByBundle = new Map<string, Awaited<ReturnType<typeof detectChangedKeys>>>();
  for (const bundle of bundles) {
    const changes = await detectChangedKeys(cli.root, bundle.sourceFile.absPath);
    changedByBundle.set(bundle.id, changes);
  }
  const totalChanges = [...changedByBundle.values()].reduce((s, list) => s + list.length, 0);
  info(`  Total changed source-locale keys: ${totalChanges}`);

  if (totalChanges === 0) {
    info("\nNo translation changes detected.\nRun the agent again after future repository changes.");
    process.exit(0);
  }

  const allTasks = buildWorkQueue({ bundles, changedByBundle });

  // ── Checkpoint / resume ──────────────────────────────────────────────────
  const headSha = await getHeadSha(cli.root);
  const sourceDigests: Record<string, string> = {};
  for (const bundle of bundles) {
    const contents = await fs.readFile(bundle.sourceFile.absPath, "utf8");
    sourceDigests[bundle.id] = digestContents(contents);
  }

  let checkpoint: Checkpoint | null = null;
  let tasks = allTasks;

  if (!cli.noResume && !cli.dryRun && headSha) {
    const saved = await loadCheckpoint(cli.root);
    if (saved && isCheckpointValid(saved, headSha, sourceDigests)) {
      const completedSet = new Set(
        saved.completed.map((c) => `${c.bundleId}::${c.keyPath}`),
      );
      const resumedTasks = allTasks.filter(
        (t) => !completedSet.has(`${t.bundleId}::${t.keyPath}`),
      );
      const skipped = allTasks.length - resumedTasks.length;
      if (skipped > 0) {
        info(`  Resuming from checkpoint — ${skipped} task(s) already completed, ${resumedTasks.length} remaining.`);
        tasks = resumedTasks;
        checkpoint = saved;
      } else {
        info(`  Checkpoint found but no groups to skip — starting fresh.`);
        checkpoint = saved;
      }
    } else if (saved) {
      info(`  Checkpoint found but is stale (HEAD or source changed) — starting fresh.`);
      await deleteCheckpoint(cli.root);
    }
  }

  if (!checkpoint && !cli.dryRun && headSha) {
    checkpoint = {
      schema: 1,
      timestamp: new Date().toISOString(),
      headSha,
      sourceDigests,
      completed: [],
    };
    await saveCheckpoint(cli.root, checkpoint);
  }

  info(`  Work queue: ${tasks.length} task(s) (cartesian product of changes × target locales).`);

  const localeRulesPath = path.resolve(__dirname, "..", "data", "locale-rules.json");
  const localeRulesRaw = await fs.readFile(localeRulesPath, "utf8");
  const localeRules = JSON.parse(localeRulesRaw) as Record<string, unknown>;

  let finalReport: ReportStats | null = null;
  const webSearchByTaskId = new Map<string, HtmlWebSearchEvent[]>();
  const fallbackWebSearchEvents: HtmlWebSearchEvent[] = [];
  const commonDeps = {
    tasks,
    bundles,
    localeRules,
    webValidationEnabled: cli.webValidate,
    dryRun: cli.dryRun,
    onReport: (s: ReportStats) => { finalReport = s; },
    webSearchByTaskId,
    fallbackWebSearchEvents,
    webSearcher: cli.webValidate
      ? async (queries: Array<{ taskId: string; targetLocale: string; query: string }>) => {
          await runBatchWebSearch(queries, webSearchByTaskId);
        }
      : undefined,
    // Route MCP handler logs through `info` so they respect --json mode.
    log: (msg: string) => info(`  ${msg}`),
    onGroupCommitted: checkpoint
      ? async (bundleId: string, keyPath: string) => {
          checkpoint!.completed.push({ bundleId, keyPath });
          await saveCheckpoint(cli.root, checkpoint!);
        }
      : undefined,
  };

  // Build group preview: collapse the cartesian work queue back into the
  // {bundleId, keyPath} groups the agent actually iterates over. Keep
  // insertion order so the preview reflects dequeue order.
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
  const groupCount = groupMap.size;
  const queuePreview = [...groupMap.values()].slice(0, 5);
  info(`  Key groups: ${groupCount} (each runs shared steps once + per-locale steps × ${tasks.length / Math.max(groupCount, 1) | 0} locales).`);

  info(`\n→ Launching agent (${provider})…\n`);

  let tokenUsage: TokenUsage;
  if (provider === "openai") {
    const { tools, toolNames } = buildOpenAITools(commonDeps);
    const systemPrompt = await buildSystemPrompt({
      bundleCount: bundles.length,
      taskCount: tasks.length,
      groupCount,
      queuePreview,
      webValidationEnabled: cli.webValidate,
      toolNames,
    });
    tokenUsage = await runOpenAI({ model, systemPrompt, root: cli.root, webValidate: cli.webValidate, taskCount: tasks.length, tools, webSearchByTaskId, fallbackWebSearchEvents, quiet: cli.json });
  } else {
    const { server, toolNames } = buildAnthropicServer(commonDeps);
    const systemPrompt = await buildSystemPrompt({
      bundleCount: bundles.length,
      taskCount: tasks.length,
      groupCount,
      queuePreview,
      webValidationEnabled: cli.webValidate,
      toolNames,
    });
    tokenUsage = await runAnthropic({ model, systemPrompt, root: cli.root, webValidate: cli.webValidate, taskCount: tasks.length, server, toolNames, webSearchByTaskId, fallbackWebSearchEvents, quiet: cli.json });
  }

  if (finalReport) {
    // Delete the checkpoint on successful completion so a subsequent run
    // starts fresh rather than finding an empty (fully-completed) checkpoint.
    if (!cli.dryRun) {
      await deleteCheckpoint(cli.root);
    }

    if (cli.json) {
      // The single piece of content that goes to stdout in JSON mode.
      process.stdout.write(JSON.stringify(finalReport, null, 2) + "\n");
    } else {
      printReport(finalReport);
      const ledger = await updateTokenLedger(cli.root, tokenUsage);
      info(`\nToken usage (this run):  ${tokenUsage.inputTokens.toLocaleString()} in / ${tokenUsage.outputTokens.toLocaleString()} out`);
      info(`Token usage (all runs):  ${ledger.totalInputTokens.toLocaleString()} in / ${ledger.totalOutputTokens.toLocaleString()} out  (${ledger.runs} run${ledger.runs === 1 ? "" : "s"})`);
      if (cli.dryRun) {
        info("\n[dry-run] No files were written. Re-run without --dry-run to apply.");
      }
    }

    if (cli.htmlReport) {
      try {
        const htmlReportPath = await writeHtmlReport(cli.root, finalReport);
        info(`HTML report: ${htmlReportPath}`);
      } catch (e) {
        console.error(`Failed to write HTML report: ${(e as Error).message}`);
      }
    }

    process.exit(0);
  }

  console.error("\nAgent finished without emitting a report. Some translations may not have been written.");
  process.exit(2);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err}`);
  process.exit(1);
});
