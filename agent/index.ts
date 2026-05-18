#!/usr/bin/env node
import "dotenv/config";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Agent, run, tool } from "@openai/agents";
import fg from "fast-glob";
import { scanRepository } from "./repository.js";
import { ensureCleanGitState, detectChangedKeys, isGitRepo } from "./git.js";
import { buildWorkQueue } from "./work-queue.js";
import { buildMcpServer, type ReportStats } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildGlossary, type LocaleEntries } from "../lib/glossary.js";

const execAsync = promisify(exec);

type Cli = {
  webValidate: boolean;
  sourceLocale?: string;
  root: string;
  model: string;
  help: boolean;
};

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    webValidate: false,
    root: process.cwd(),
    model: "gpt-4o",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") cli.help = true;
    else if (a === "--web-validate") cli.webValidate = true;
    else if (a === "--source-locale") cli.sourceLocale = argv[++i];
    else if (a === "--root") cli.root = path.resolve(argv[++i] ?? process.cwd());
    else if (a === "--model") cli.model = argv[++i] ?? "gpt-4o";
  }
  return cli;
}

function printHelp() {
  console.log(`translations-agent — repository-aware localization automation

Usage:
  translations-agent [options]

Options:
  --web-validate              Enable web search validation for ambiguous/legal content
  --source-locale <code>      Override source-locale auto-detection
  --root <path>               Operate on a directory other than cwd
  --model <name>              OpenAI model to use (default: gpt-4o)
  --help, -h                  Show this help message

The agent must be run inside a git repository. It detects changed source-locale keys
and translates them into target locale files in the same directory.`);
}

async function askPermission(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nThe agent requires:`);
  console.log(`  ✓ Read access to repository`);
  console.log(`  ✓ Write access to localization files`);
  console.log(`  ✓ Permission to execute bash/git commands`);
  const answer = await new Promise<string>((resolve) =>
    rl.question(`\nContinue? (y/N) `, resolve),
  );
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

// ── Built-in filesystem tools (analogues of Anthropic's Read / Glob / Bash) ──

function makeFileSystemTools(root: string) {
  const readFileTool = tool({
    name: "Read",
    description: "Read a file from the filesystem and return its contents.",
    parameters: z.object({
      file_path: z.string().describe("Absolute path to the file to read"),
    }),
    execute: async (input: { file_path: string }) => {
      try {
        return await fs.readFile(input.file_path, "utf8");
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    },
  });

  const globTool = tool({
    name: "Glob",
    description: "Find files matching a glob pattern. Searches relative to the repository root.",
    parameters: z.object({
      pattern: z.string().describe("Glob pattern to match"),
      cwd: z.string().optional().describe("Directory to search from (defaults to repo root)"),
    }),
    execute: async (input: { pattern: string; cwd?: string }) => {
      try {
        const matches = await fg(input.pattern, {
          cwd: input.cwd ?? root,
          absolute: true,
          dot: false,
        });
        return matches.join("\n") || "(no matches)";
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  const bashTool = tool({
    name: "Bash",
    description:
      "Execute a bash command in the repository root. Returns stdout; stderr is appended if non-empty.",
    parameters: z.object({
      command: z.string().describe("The shell command to run"),
    }),
    execute: async (input: { command: string }) => {
      try {
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: root,
          timeout: 30_000,
        });
        return stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });

  const webSearchTool = tool({
    name: "WebSearch",
    description:
      "Search the web for authoritative sources on a translation term or legal phrase. Returns a brief summary of findings.",
    parameters: z.object({
      query: z.string().describe("The search query"),
    }),
    execute: async (input: { query: string }) => {
      // Requires OPENAI_API_KEY with web search access. Falls back gracefully.
      try {
        const { default: OpenAI } = await import("openai");
        const openai = new OpenAI();
        const response = await (openai.responses as any).create({
          model: "gpt-4o",
          tools: [{ type: "web_search_preview" }],
          input: `Search for: ${input.query}. Provide a concise factual summary relevant to software localization or legal terminology translation.`,
        });
        const text = response.output
          ?.filter((b: any) => b.type === "message")
          .flatMap((b: any) => b.content)
          .filter((c: any) => c.type === "output_text")
          .map((c: any) => c.text)
          .join("\n");
        return text ?? "(no results)";
      } catch {
        return `(web search unavailable — treat webScore as 0.6 for a single uncertain source)`;
      }
    },
  });

  return { readFileTool, globTool, bashTool, webSearchTool };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY is not set. Add it to your environment or .env file.");
    process.exit(1);
  }

  console.log(`translations-agent`);
  console.log(`Root: ${cli.root}`);

  if (!(await isGitRepo(cli.root))) {
    console.error(`ERROR: ${cli.root} is not a git repository.`);
    process.exit(1);
  }

  const proceed = await askPermission();
  if (!proceed) {
    console.log("Aborted.");
    process.exit(1);
  }

  console.log("\n→ Pre-flight: scanning repository, diffing source locale, building work queue…");

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
    console.log("No locale bundles detected. Exiting.");
    process.exit(0);
  }

  console.log(`  Detected ${bundles.length} bundle(s):`);
  for (const b of bundles) {
    console.log(
      `    ${b.id}: source=${b.sourceLocale}, targets=[${b.targets.map((t) => t.locale).join(", ")}]`,
    );
  }

  const changedByBundle = new Map<string, Awaited<ReturnType<typeof detectChangedKeys>>>();
  for (const bundle of bundles) {
    const changes = await detectChangedKeys(cli.root, bundle.sourceFile.absPath);
    changedByBundle.set(bundle.id, changes);
  }
  const totalChanges = [...changedByBundle.values()].reduce((s, list) => s + list.length, 0);
  console.log(`  Total changed source-locale keys: ${totalChanges}`);

  if (totalChanges === 0) {
    console.log("\nNo translation changes detected.\nRun the agent again after future repository changes.");
    process.exit(0);
  }

  const tasks = buildWorkQueue({ bundles, changedByBundle });
  console.log(`  Work queue: ${tasks.length} task(s) (cartesian product of changes × target locales).`);

  const localeEntries: LocaleEntries[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles) {
    for (const file of [bundle.sourceFile, ...bundle.targets]) {
      if (seen.has(file.absPath)) continue;
      seen.add(file.absPath);
      localeEntries.push({ locale: file.locale, entries: file.entries });
    }
  }
  const glossary = buildGlossary(localeEntries, bundles[0]!.sourceLocale);
  console.log(`  Glossary: ${glossary.length} entries auto-built from existing translations.`);

  const localeRulesPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "data",
    "locale-rules.json",
  );
  const localeRulesRaw = await fs.readFile(localeRulesPath, "utf8");
  const localeRules = JSON.parse(localeRulesRaw) as Record<string, unknown>;

  let finalReport: ReportStats | null = null;
  const { tools: mcpTools, toolNames } = buildMcpServer({
    tasks,
    bundles,
    glossary,
    localeRules,
    webValidationEnabled: cli.webValidate,
    onReport: (s) => {
      finalReport = s;
    },
    log: (msg) => {
      if (process.env.DEBUG_TRACE) console.log(`  ${msg}`);
    },
  });

  const previewCount = Math.min(5, tasks.length);
  const queuePreview = tasks.slice(0, previewCount).map((t) => ({
    taskId: t.taskId,
    bundleId: t.bundleId,
    targetLocale: t.targetLocale,
    keyPath: t.keyPath,
    placement: t.placement,
  }));

  const systemPrompt = await buildSystemPrompt({
    bundleCount: bundles.length,
    taskCount: tasks.length,
    queuePreview,
    webValidationEnabled: cli.webValidate,
    toolNames,
  });

  const { readFileTool, globTool, bashTool, webSearchTool } = makeFileSystemTools(cli.root);

  const allTools = [
    ...mcpTools,
    readFileTool,
    globTool,
    bashTool,
    ...(cli.webValidate ? [webSearchTool] : []),
  ];

  console.log("\n→ Launching agent…\n");

  const agent = new Agent({
    name: "Translations Agent",
    instructions: systemPrompt,
    model: cli.model,
    tools: allTools,
  });

  const maxTurns = Math.max(80, tasks.length * 12);

  const streamedResult = await run(agent, "Begin. Call next_task() to start.", {
    stream: true,
    maxTurns,
  });

  for await (const event of streamedResult) {
    if (event.type === "run_item_stream_event") {
      const item = event.item;
      if (item.type === "message_output_item") {
        const content = (item.rawItem as { content?: Array<{ type: string; text?: string }> })
          .content ?? [];
        for (const block of content) {
          if (block.type === "output_text" && block.text) {
            process.stdout.write(block.text);
          }
        }
      }
    }
  }

  const finalOutput = streamedResult.finalOutput;
  if (finalOutput && typeof finalOutput === "string" && finalOutput.trim()) {
    process.stdout.write(finalOutput + "\n");
  } else {
    process.stdout.write("\n");
  }

  if (finalReport) {
    printReport(finalReport);
    process.exit(0);
  }

  console.error("\nAgent finished without emitting a report. Some translations may not have been written.");
  process.exit(2);
}

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

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err}`);
  process.exit(1);
});
