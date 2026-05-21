#!/usr/bin/env node
import "dotenv/config";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { scanRepository } from "./repository.js";
import { ensureCleanGitState, detectChangedKeys, isGitRepo, getHeadSha } from "./git.js";
import { loadCheckpoint, saveCheckpoint, deleteCheckpoint, isCheckpointValid, digestContents, type Checkpoint } from "../lib/checkpoint.js";
import { buildWorkQueue } from "./work-queue.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildGlossary, mergeWithSeed, type GlossaryEntry, type LocaleEntries } from "../lib/glossary.js";
import { buildOpenAITools } from "./tools-openai.js";
import { buildAnthropicServer } from "./tools-anthropic.js";
import { writeHtmlReport } from "./html-report.js";
import type { HtmlWebSearchEvent, ReportStats } from "./tools-core.js";

// Resolved once at module load so both dev (tsx agent/index.ts) and prod
// (dist/agent/index.js) walk up to the correct asset root: repo-root in dev,
// dist/ in prod (where copy-assets.mjs mirrors data/ and prompts/).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ────────────────────────────────────────────────────────────────────────

type Provider = "openai" | "anthropic";

type Cli = {
  webValidate: boolean;
  noGlossary: boolean;
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
    noGlossary: false,
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
    else if (a === "--no-glossary") cli.noGlossary = true;
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
  --no-glossary               Disable glossary matching (useful for testing raw model output)
  --source-locale <code>      Override source-locale auto-detection
  --root <path>               Operate on a directory other than cwd
  --model <name>              Override the model (default: gpt-4o for OpenAI, claude-opus-4-7 for Anthropic)
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

  OPENAI_API_KEY=<key>       → uses OpenAI agents SDK  (default model: gpt-4o)
  ANTHROPIC_API_KEY=<key>    → uses Anthropic Claude SDK (default model: claude-opus-4-7)
`);
  process.exit(1);
}

async function askProviderChoice(): Promise<Provider> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nBoth OPENAI_API_KEY and ANTHROPIC_API_KEY are set.");
  console.log("  1) OpenAI    (default model: gpt-4o)");
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
}) {
  const { Agent, run, tool } = await import("@openai/agents");

  const extractOutputText = (response: any): string =>
    (response?.output ?? [])
      .filter((b: any) => b?.type === "message")
      .flatMap((b: any) => b?.content ?? [])
      .filter((c: any) => c?.type === "output_text")
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");

  const parseStructuredJson = (text: string): { summary?: string; sources?: Array<{ url?: string; title?: string }> } | null => {
    const trimmed = text.trim();
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const firstBrace = unfenced.indexOf("{");
    const lastBrace = unfenced.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    const candidate = unfenced.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) return null;
      return parsed as { summary?: string; sources?: Array<{ url?: string; title?: string }> };
    } catch {
      return null;
    }
  };

  const captureSourceLinks = (response: any): Array<{ url: string; title?: string }> => {
    const dedup = new Map<string, { url: string; title?: string }>();

    const contentBlocks = (response?.output ?? [])
      .filter((b: any) => b?.type === "message")
      .flatMap((b: any) => b?.content ?? []);

    for (const block of contentBlocks) {
      const annotations = Array.isArray(block?.annotations) ? block.annotations : [];
      for (const ann of annotations) {
        const url = typeof ann?.url === "string" ? ann.url : undefined;
        if (!url) continue;
        const title = typeof ann?.title === "string" ? ann.title : undefined;
        if (!dedup.has(url)) dedup.set(url, { url, title });
      }
    }

    const text = extractOutputText(response);
    const urlMatches = text.match(/https?:\/\/[^\s)\]]+/g) ?? [];
    for (const m of urlMatches) {
      if (!dedup.has(m)) dedup.set(m, { url: m });
    }

    const structured = parseStructuredJson(text);
    const structuredSources = Array.isArray(structured?.sources) ? structured.sources : [];
    for (const src of structuredSources) {
      const url = typeof src?.url === "string" ? src.url.trim() : "";
      if (!url) continue;
      const title = typeof src?.title === "string" && src.title.trim().length > 0 ? src.title.trim() : undefined;
      if (!dedup.has(url)) dedup.set(url, { url, title });
    }

    return [...dedup.values()];
  };

  const buildWebSearchPrompt = (query: string, retry: boolean): string => {
    const retryNote = retry
      ? "Previous attempt returned no usable source URLs. Retry and include concrete links."
      : "";
    return [
      retryNote,
      `Search for: ${query}`,
      "Return ONLY valid JSON with this shape:",
      '{"summary":"<concise factual summary>","sources":[{"url":"https://...","title":"..."}]}',
      "Include 2+ authoritative source URLs when available. Do not include markdown.",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  };

  const webSearchTool = tool({
    name: "WebSearch",
    description: "Search the web for authoritative sources on a translation term or legal phrase. Always pass the locale taskId and targetLocale to support run reporting.",
    parameters: z.object({
      query: z.string(),
      taskId: z.string().nullable().optional(),
      targetLocale: z.string().nullable().optional(),
    }),
    execute: async (input: { query: string; taskId?: string | null; targetLocale?: string | null }) => {
      try {
        const { default: OpenAI } = await import("openai");
        const openai = new OpenAI();
        const runSearch = async (retry: boolean) =>
          (openai.responses as any).create({
            model: "gpt-4o",
            tools: [{ type: "web_search_preview" }],
            input: buildWebSearchPrompt(input.query, retry),
          });

        let response = await runSearch(false);
        let text = extractOutputText(response);
        let sources = captureSourceLinks(response);

        // One retry maximum when no URLs were captured.
        if (sources.length === 0) {
          response = await runSearch(true);
          text = extractOutputText(response);
          sources = captureSourceLinks(response);
        }

        const structured = parseStructuredJson(text);
        const summary =
          typeof structured?.summary === "string" && structured.summary.trim().length > 0
            ? structured.summary.trim()
            : text;

        if (input.taskId) {
          const existing = opts.webSearchByTaskId.get(input.taskId) ?? [];
          existing.push({
            query: input.query,
            targetLocale: input.targetLocale ?? undefined,
            summary: summary ?? "",
            sources,
          });
          opts.webSearchByTaskId.set(input.taskId, existing);
        } else {
          opts.fallbackWebSearchEvents.push({
            query: input.query,
            targetLocale: input.targetLocale ?? undefined,
            summary: summary ?? "",
            sources,
          });
        }

        return summary ?? "(no results)";
      } catch {
        return "(web search unavailable — treat webScore as 0.6 for a single uncertain source)";
      }
    },
  });

  const allTools = [
    ...opts.tools,
    ...(opts.webValidate ? [webSearchTool] : []),
  ];

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
  quiet: boolean;
}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const builtInTools: string[] = opts.webValidate ? ["WebSearch"] : [];

  const allowedTools = [...opts.toolNames, ...builtInTools];
  const maxTurns = Math.max(80, opts.taskCount * 12);

  const q = query({
    prompt: "Begin. Call next_task() to start.",
    options: {
      cwd: opts.root,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      mcpServers: { localizer: opts.server },
      allowedTools,
      tools: builtInTools,
      maxTurns,
    },
  });

  const out = opts.quiet ? () => {} : (s: string) => process.stdout.write(s);

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
      if (message.subtype === "success") {
        if (!opts.quiet) console.log("\n");
      } else {
        // Errors always go to stderr regardless of mode.
        console.error(`\nAgent ended with: ${message.subtype}`);
      }
      break;
    }
  }
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
  const model = cli.model ?? (provider === "openai" ? "gpt-4o" : "claude-opus-4-7");

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

  const localeEntries: LocaleEntries[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles) {
    for (const file of [bundle.sourceFile, ...bundle.targets]) {
      if (seen.has(file.absPath)) continue;
      seen.add(file.absPath);
      localeEntries.push({ locale: file.locale, entries: file.entries });
    }
  }
  let glossary: GlossaryEntry[] = [];
  if (!cli.noGlossary) {
    const autoBuilt = buildGlossary(localeEntries, bundles[0]!.sourceLocale);
    const seedPath = path.resolve(__dirname, "..", "data", "glossary-seed.json");
    const seed = JSON.parse(await fs.readFile(seedPath, "utf8")) as GlossaryEntry[];
    glossary = mergeWithSeed(autoBuilt, seed);
    info(`  Glossary: ${glossary.length} entries (${seed.length} seed + ${autoBuilt.length} auto-built, after merge).`);
  } else {
    info("  Glossary: disabled (--no-glossary)");
  }

  const localeRulesPath = path.resolve(__dirname, "..", "data", "locale-rules.json");
  const localeRulesRaw = await fs.readFile(localeRulesPath, "utf8");
  const localeRules = JSON.parse(localeRulesRaw) as Record<string, unknown>;

  let finalReport: ReportStats | null = null;
  const webSearchByTaskId = new Map<string, HtmlWebSearchEvent[]>();
  const fallbackWebSearchEvents: HtmlWebSearchEvent[] = [];
  const commonDeps = {
    tasks,
    bundles,
    glossary,
    localeRules,
    webValidationEnabled: cli.webValidate,
    dryRun: cli.dryRun,
    onReport: (s: ReportStats) => { finalReport = s; },
    webSearchByTaskId,
    fallbackWebSearchEvents,
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
    await runOpenAI({ model, systemPrompt, root: cli.root, webValidate: cli.webValidate, taskCount: tasks.length, tools, webSearchByTaskId, fallbackWebSearchEvents, quiet: cli.json });
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
    await runAnthropic({ model, systemPrompt, root: cli.root, webValidate: cli.webValidate, taskCount: tasks.length, server, toolNames, quiet: cli.json });
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
