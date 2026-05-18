# translations-agent

## What it does

`translations-agent` is a CLI tool that automatically keeps your app's translation files in sync. You run it inside any git repository that contains JSON locale files (e.g. `en.json`, `fr.json`). It compares the current git diff, finds any source-language keys that were added or changed, and uses an AI model to translate only those keys into every other language — writing the results directly back into the right locale files. It never modifies application code, never deletes keys, and never re-translates keys that haven't changed.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20, TypeScript |
| AI providers | OpenAI (`gpt-4o` via `@openai/agents`) or Anthropic (`claude-opus-4-7` via `@anthropic-ai/claude-agent-sdk`) |
| Git integration | `simple-git` |
| File scanning | `fast-glob` |
| Schema validation | `zod` |

---

## Architecture

```
translations-agent/
├── agent/
│   ├── index.ts          CLI entry — parses flags, runs pre-flight, launches AI
│   ├── tools.ts          MCP tools exposed to the AI (work queue, commit, glossary)
│   ├── system-prompt.ts  Builds the instruction prompt for the AI
│   ├── repository.ts     Scans the repo and discovers locale bundles
│   ├── git.ts            Detects which keys changed since last commit
│   ├── work-queue.ts     Flattens changed keys into a task list
│   └── locale-writer.ts  Atomic JSON writer — the only thing that touches locale files
├── lib/
│   ├── flatten-json.ts   Converts nested JSON ↔ flat key paths
│   ├── placeholders.ts   Protects {{variables}} from being translated
│   ├── glossary.ts       Builds a project-specific term glossary automatically
│   └── locale-validator.ts / confidence-scorer.ts / domain-classifier.ts
└── data/
    └── locale-rules.json  Per-language grammar and formatting rules
```

**How a run works:**
1. Pre-flight: the CLI scans the repo, detects changed source-locale keys via `git diff`, and builds a work queue.
2. The AI is launched once and drains the queue task-by-task using MCP tools (`next_task`, `normalize_text`, `validate_translation`, `commit_bundle`, etc.).
3. Each translation goes through an 8-step pipeline: classify → get rules → normalize → translate → validate → score → commit.
4. Results are written atomically. If confidence is below 0.85, a `<key>__needsReview: true` flag is added alongside the translation.

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set your API key

Create a `.env` file in the root of **this** repo (or export into your shell):

```
# Pick one:
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

If both are set, the agent will ask you to choose at startup.

### 3. Run inside your target repository

Navigate to the repo whose locale files you want to translate, then run:

```bash
# Using npx + tsx (no build step needed):
npx tsx /path/to/translations-agent/agent/index.ts

# Or after building (npm run build):
translations-agent
```

The agent will ask for confirmation before writing anything.

---

## Flags

| Flag | What it does |
|---|---|
| `--web-validate` | Cross-checks ambiguous or legal phrases against live web sources before committing |
| `--source-locale <code>` | Override auto-detection of the source language (e.g. `--source-locale en-US`) |
| `--root <path>` | Point to a different directory instead of the current working directory |
| `--model <name>` | Use a specific model (e.g. `--model gpt-4o-mini`). Defaults to `gpt-4o` for OpenAI and `claude-opus-4-7` for Anthropic |
| `--help`, `-h` | Print the help message |

### Examples

```bash
# Basic run — detects provider from .env, translates changed keys
translations-agent

# Use a different model
translations-agent --model gpt-4o-mini

# Operate on a repo in another folder
translations-agent --root ../my-app

# Force a specific source locale and enable web validation
translations-agent --source-locale en-US --web-validate
```

---

## Debugging

| Tip | How |
|---|---|
| See every tool call the AI makes | `DEBUG_TRACE=1 translations-agent` |
| Check the work queue before the AI runs | It is printed to the console at the end of pre-flight |
| Translations look wrong | Check what `get_locale_rules` returned — the AI relies on those rules |
| AI skips pipeline steps | Look for `MISSING_TRACE_TOKEN` in the output |
| `commit_bundle` keeps rejecting | A `{{placeholder}}` was lost during translation — check the source file |
