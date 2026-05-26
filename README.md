# translations-agent

A CLI that keeps your app's translation files in sync. Run it inside any git repository that contains JSON locale files (`en.json`, `fr.json`, …). It diffs the source locale against the last commit, finds added or changed keys, and uses an AI model to translate them into every target locale — writing results back into the right files. It never modifies application code, never deletes keys, and never re-translates keys that haven't changed.

---

## Quick Setup Guide

No Node required — just Podman (or Docker).

**Step 1 — pull the image** (no clone or build needed):

```bash
podman pull ghcr.io/kboshnjaku-reveal/translations-agent:main
```

**Step 2 — run against any repo** (swap in your path and key):

```bash
podman run --rm \
  -v /path/to/your-app:/repo \
  -e ANTHROPIC_API_KEY=sk-ant-your-key-here \
  ghcr.io/kboshnjaku-reveal/translations-agent:main --yes
```

Use `OPENAI_API_KEY` instead if you prefer the OpenAI provider. The `--yes` flag is required — the container cannot answer interactive prompts.

---

## Getting started

### 1. Install

```bash
npm install
```

Requires Node ≥ 20.

### 2. Set your API key

```bash
cp .env.example .env
# edit .env and uncomment one of OPENAI_API_KEY / ANTHROPIC_API_KEY
```

If both keys are set, the CLI will ask you to choose at startup.

### 3. Run inside your target repository

```bash
# Dev (no build step):
npx tsx /path/to/translations-agent/agent/index.ts

# Or after `npm run build`:
translations-agent
```

The agent prompts for confirmation before writing anything. Pass `--yes` to skip the prompt (for CI), or `--dry-run` to preview without writing.

### 4. Running with Podman / Docker (no Node required)

Pull the pre-built image from GHCR:

```bash
podman pull ghcr.io/kboshnjaku-reveal/translations-agent:main
```

Then run it from anywhere by mounting your target repo as a volume:

```bash
podman run --rm \
  -v /path/to/your-app:/repo \
  -e ANTHROPIC_API_KEY=sk-ant-your-key-here \
  ghcr.io/kboshnjaku-reveal/translations-agent:main --yes
```

Use `OPENAI_API_KEY` instead if you prefer the OpenAI provider. The `--yes` flag is required — the interactive confirmation prompt cannot be answered inside a container.

---

## Flags

| Flag | What it does |
|---|---|
| `--dry-run` | Run the full pipeline (model calls, validation, scoring) but skip the final disk writes. Report stats are still produced. Progress is not checkpointed in dry-run mode. |
| `--yes`, `-y` | Skip the interactive permission prompt. Use for unattended runs (CI, scripts). |
| `--json` | Emit the final report as JSON on stdout. Progress and tool-call narration are routed to stderr. |
| `--no-web-validate` | Disable web search validation for ambiguous or legal phrases (enabled by default). |
| `--glossary` | Build a translation glossary from existing locale files during pre-flight. Keys with a single exact match across all target locales skip the AI call entirely (score 100%, no web search). |
| `--source-locale <code>` | Override auto-detection of the source language (e.g. `--source-locale en-US`). |
| `--root <path>` | Operate on a directory other than the current working directory. |
| `--model <name>` | Use a specific model. Defaults to `gpt-4o-mini` (OpenAI) or `claude-opus-4-7` (Anthropic). |
| `--no-html-report` | Disable HTML report generation. By default, each run writes `reports/translation-report-YYYYMMDD-HHMMSS.html`. |
| `--no-resume` | Skip loading a saved checkpoint and start from scratch. Progress is still checkpointed for future runs unless `--dry-run` is also set. |
| `--help`, `-h` | Print the help message. |

### Examples

```bash
# Basic run — detect provider from .env, translate changed keys
translations-agent

# Preview without writing (good for PRs / CI gates)
translations-agent --dry-run --yes

# Machine-readable report for piping into jq, GitHub Actions, etc.
translations-agent --dry-run --yes --json | jq '.flaggedForReview'

# Use a cheaper model
translations-agent --model gpt-4o-mini

# Operate on a repo in another folder
translations-agent --root ../my-app

# Force a specific source locale and disable web validation
translations-agent --source-locale en-US --no-web-validate

# Start from scratch, ignoring any saved checkpoint
translations-agent --no-resume
```

---

## What it does (and what it doesn't)

**Does:**

- Detects added and modified keys in your source-locale JSON since `HEAD`.
- Translates each changed key into every target locale present in the same directory.
- Processes all target locales for a given key in a single AI reasoning turn (efficient batching).
- Preserves placeholders (`{{var}}`, `{var}`, `${var}`, `%s`, `%d`), ICU plural/select syntax, HTML tags, and escape sequences.
- Applies per-locale grammar rules (formality, spelling, anti-patterns) defined in `data/locale-rules.json`.
- Scores each translation; low-confidence translations get a sibling `<key>__needsReview: true` flag rather than being dropped.
- Builds a translation glossary from existing locale files when `--glossary` is set.
  Keys whose source value exactly matches a glossary entry across every target locale
  are committed directly without an AI call, scored at 100% confidence.
- Saves a checkpoint after each key group so a crashed or interrupted run can resume where it left off.
- Writes atomically (tmp + rename), so a crash mid-write leaves the original file intact.
- Writes a token usage ledger to `.translations-agent-usage.json` in your repo root.

**Does not:**

- Modify application code, refactor, or rename keys.
- Translate from a non-source locale.
- Delete existing keys.
- Re-translate keys whose values did not change.
- Stay interactive — it exits after one run by design.

---

## Output and review workflow

After a run, the CLI prints a report showing:

- Detected bundles (each directory containing source-locale JSON is its own bundle).
- Total changed keys, translated automatically, flagged for review.
- Updated files.
- Review queue — keys written with `__needsReview: true` and the reason.
- Token usage for this run and cumulative totals.

A confidence score below 0.85 produces an `__needsReview: true` sibling key. The translation is still written (best-effort), but you should treat it as a draft. Search your locales for `__needsReview` after a run, fix or accept each one, and delete the flag.

By default, each successful run also writes an interactive HTML report to:

`reports/translation-report-YYYYMMDD-HHMMSS.html`

Use `--no-html-report` to skip this artifact.

The HTML report includes per-locale web validation context when captured during the run:

- Web search queries
- Source/reference links found during web search
- Evidence summaries returned by the search step
- Evidence transparency metadata (`evidenceStatus`, `evidenceOrigin`, score source)
- Raw WebSearch transcript entries (query + response summary + source count)

In `--json` mode, the same data lands on stdout as a single JSON object — useful for PR bots and CI gates:

```json
{
  "detectedBundles": 1,
  "sourceLocale": "en",
  "targetLocales": ["de", "es", "nl"],
  "changedKeys": 3,
  "translatedAuto": 7,
  "flaggedForReview": 2,
  "updatedFiles": ["locales/de.json", "locales/es.json", "locales/nl.json"],
  "reviewKeys": [
    { "bundle": "locales", "locale": "de", "keyPath": "checkout.legal", "reason": "..." }
  ]
}
```

---

## Checkpoint and resume

Each non-dry-run execution saves a checkpoint to `.translations-agent/state.json` in your target repository. If a run is interrupted (crash, timeout, Ctrl-C), the next run automatically picks up from where it left off — already-translated key groups are skipped.

The checkpoint is tied to the current HEAD commit and source file contents. If you commit new changes or edit the source locale between runs, the checkpoint is discarded and the run starts fresh.

Use `--no-resume` to force a full restart regardless of any saved checkpoint.

---

## Security model

The agent runs against your real filesystem and your git config, so the tool was built with the principle of least privilege:

- **No shell access.** The agent has no `Bash`, `Exec`, or `Shell` tool. It cannot run arbitrary commands.
- **No raw file writes.** Locale JSON is written only through the `commit_bundle` MCP tool, which runs a server-side placeholder structure check before persisting. Updates that lose or break a placeholder are rejected.
- **Scoped reads.** The agent reads locale files only through `read_locale_file`, restricted to the bundles discovered during pre-flight. It cannot read arbitrary files in your repo.
- **Atomic writes.** Each locale file is written via `tmp + rename`, so a crash mid-write leaves the original intact.
- **Git diff is the source of truth.** Deterministic pre-flight (not the AI) decides which keys to translate. The agent can only act on the queue it is handed.
- **Dry-run available.** `--dry-run` runs every model call and validator but skips disk writes, so you can preview the full report before applying.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Translations look wrong | Check `data/locale-rules.json` for the target locale — the agent relies on those rules. |
| `commit_bundle` keeps rejecting | A `{{placeholder}}` was lost during translation. Inspect the source file and the rejection reason. |
| Unexpected work queue | The queue size is printed to stderr at the end of pre-flight, before the agent loop starts. |
| Provider not selected | Confirm the correct key is exported. Both keys set triggers the interactive choice prompt — pass `--yes` after first time. |
| `Agent finished without emitting a report` | The agent exited before calling `commit_bundle` (or called it without a result). Usually means `maxTurns` (5) was exhausted for a group. Re-run; if it persists, check `--dry-run` output for that group. |
| Checkpoint not resuming | HEAD SHA or a source file changed since the last run — the stale checkpoint is deleted automatically and a fresh run begins. |
| Run starts over unexpectedly | Check if `--no-resume` or `--dry-run` is set; both skip checkpoint loading. |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout, architecture, dev workflow, and how to extend the pipeline.
