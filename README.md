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
│   ├── index.ts            CLI entry — parses flags, runs pre-flight, launches AI
│   ├── tools-core.ts       Shared MCP handler logic (next_key_group, pipeline, commit)
│   ├── tools-openai.ts     OpenAI tool builder — wraps handlers as @openai/agents tools
│   ├── tools-anthropic.ts  Anthropic tool builder — wraps handlers in an MCP SDK server
│   ├── system-prompt.ts    Builds the instruction prompt for the AI (group-aware)
│   ├── repository.ts       Scans the repo and discovers locale bundles
│   ├── git.ts              Detects which keys changed since last commit
│   ├── work-queue.ts       Builds the task list and pre-computes deterministic steps
│   └── locale-writer.ts    Atomic JSON writer — the only thing that touches locale files
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
2. Pre-flight also pre-computes deterministic steps (`normalizeWhitespace`, `maskPlaceholders`, `classifyDomain`) once per unique source key — the agent reads those results instead of re-computing them per locale.
3. The AI is launched once and drains the queue **one key group at a time** using MCP tools (`next_key_group`, `normalize_text`, `validate_translation`, `commit_bundle`, etc.). A *key group* is one source key plus every target locale that needs it translated.
4. Within a group: shared steps (`normalize_text`, `classify_domain`) run once; per-locale steps (`search_glossary`, `get_locale_rules`, `validate_translation`, `score_confidence`) run once per locale; all M locale translations are produced in a single model reasoning turn; one batched `commit_bundle` persists them all.
5. Results are written atomically. If confidence is below 0.85, a `<key>__needsReview: true` flag is added alongside the translation.

### Why key groups?

For **N changed keys × M target locales**, the naive structure does N×M iterations end-to-end. Two optimisations collapse the work:

| Step | Naive | Key-group |
|---|---|---|
| `normalize_text` / `classify_domain` | N×M (recomputed per locale) | N (pre-flight, cached per source key) |
| `search_glossary` / `get_locale_rules` | N×M | N×M (locale-specific — unchanged) |
| Model translate round-trips | N×M (one per locale) | N (M translations in one reasoning turn) |
| `commit_bundle` calls | N×M | N (M updates batched per call) |

The dominant wall-clock win is collapsing N×M sequential model round-trips into N batched ones. Trace-token validation still runs per locale — shared steps fan their token to every member of the group so each locale's `validate_translation` sees the full chain.

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
| `--no-web-validate` | Disable web search validation for ambiguous or legal phrases (enabled by default) |
| `--no-glossary` | Disable glossary matching (useful for testing raw model output) |
| `--source-locale <code>` | Override auto-detection of the source language (e.g. `--source-locale en-US`) |
| `--root <path>` | Point to a different directory instead of the current working directory |
| `--model <name>` | Use a specific model (e.g. `--model gpt-4o-mini`). Defaults to `gpt-4o` for OpenAI and `claude-opus-4-7` for Anthropic |
| `--help`, `-h` | Print the help message |

### Examples

```bash
# Basic run — detects provider from .env, translates changed keys (web validation on by default)
translations-agent

# Use a different model
translations-agent --model gpt-4o-mini

# Operate on a repo in another folder
translations-agent --root ../my-app

# Force a specific source locale and disable web validation
translations-agent --source-locale en-US --no-web-validate

# Skip glossary matching to test raw model output
translations-agent --no-glossary
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
| Agent finishes with low translated counts | Check the pre-flight log for `Key groups: N` — each group should consume ~10–15 turns. If the queue is large, the agent may exhaust `maxTurns`; the group-based loop already reduces this ~2–3× vs. one-task-at-a-time |
