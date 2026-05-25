# Contributing to translations-agent

This is the entry point for working on the agent itself. For deep architectural detail and design invariants, see [CLAUDE.md](CLAUDE.md). For user-facing docs, see [README.md](README.md).

---

## Setup

```bash
git clone <repo-url>
cd translations-agent
npm install
cp .env.example .env
# set one API key
```

Alternatively, build the container image and skip the Node install entirely:

```bash
podman build -t translations-agent .
# Run against any target repo:
podman run --rm -v /path/to/your-app:/repo -e ANTHROPIC_API_KEY=sk-... localhost/translations-agent --yes
```

See [README.md § Running with Podman / Docker](README.md#4-running-with-podman--docker-no-node-required) for full details.

Smoke-test the pre-flight pipeline without making any AI calls:

```bash
npx tsx scripts/smoke-preflight.ts fixtures/sample-repo
```

Smoke-test the MCP handlers directly (no provider involved):

```bash
npx tsx scripts/smoke-mcp.ts
```

---

## Dev workflow

```bash
npm run dev          # run via tsx, no build step
npm run typecheck    # tsc --noEmit
npm run build        # tsc + copy data/ and prompts/ into dist/
npm start            # alias for dev
npm test             # node --test --import tsx/esm test/**/*.test.ts
```

`npm run build` produces a publishable layout in `dist/`. The `scripts/copy-assets.mjs` step is required because `tsc` only emits TypeScript output — runtime assets (`data/`, `prompts/`) have to be mirrored alongside the compiled JS so the binary can resolve them at install time.

---

## Project layout

```
translations-agent/
├── agent/
│   ├── index.ts            CLI entry — flag parsing, pre-flight, checkpoint, per-group agent loop, token ledger
│   ├── tools.ts            Re-export shim — delegates to tools-openai.ts or tools-anthropic.ts
│   ├── tools-core.ts       Shared handler logic + type definitions (Task, Update, ReportStats, HTML types)
│   ├── tools-openai.ts     OpenAI tool builder (Zod schemas + @openai/agents tool() wrappers)
│   ├── tools-anthropic.ts  Anthropic tool builder (createSdkMcpServer)
│   ├── system-prompt.ts    buildGroupSystemPrompt (active) + buildSystemPrompt (legacy)
│   ├── repository.ts       Scans the repo for locale bundles
│   ├── git.ts              Computes changed source-locale keys via simple-git
│   ├── work-queue.ts       Materialises (key × locale) tasks with pre-computed normalization/classification
│   ├── locale-writer.ts    Atomic JSON merge + tmp/rename — the ONLY code that writes locale files
│   ├── html-report.ts      Generates self-contained HTML run reports
│   └── web-search-batch.ts Batch OpenAI web search for web validation (all locales in a group at once)
├── lib/
│   ├── flatten-json.ts     flatten(), setDeep(), getDeep()
│   ├── placeholders.ts     maskPlaceholders(), unmaskPlaceholders(), comparePlaceholders()
│   ├── glossary.ts         buildGlossary(), findMatches()
│   ├── domain-classifier.ts classifyDomain()
│   ├── confidence-scorer.ts scoreConfidence()
│   ├── locale-validator.ts  validateLocale()
│   ├── trace.ts            TraceRegistry — pipeline step tokens (reserved for future use)
│   └── checkpoint.ts       loadCheckpoint, saveCheckpoint, deleteCheckpoint, isCheckpointValid
├── prompts/                Markdown templates composed into the system prompt
├── data/                   Static glossary seed and per-locale rules
├── scripts/                Build helpers and smoke tests
├── test/
│   ├── lib/                Unit tests for all lib/ modules
│   └── integration/        Integration tests for locale-writer and preflight pipeline
└── fixtures/sample-repo/   Minimal git repo used by smoke tests and integration tests
```

See [CLAUDE.md](CLAUDE.md) for the file-by-file map of every export and the key invariants the codebase relies on.

---

## How a run works (short version)

1. **Pre-flight** (deterministic, no AI):
   - `repository.scanRepository` finds locale bundles by globbing for `**/locales|i18n|translations|messages/**/*.json`.
   - `git.detectChangedKeys` diffs each source locale file against `HEAD` and emits `{keyPath, oldValue, newValue, status}` per change.
   - `work-queue.buildWorkQueue` produces tasks (cartesian product of changes × target locales), caching `maskPlaceholders` and `classifyDomain` once per source key.
   - `lib/glossary.buildGlossary` mines a project-specific glossary from existing translations and merges with `data/glossary-seed.json`.
   - Checkpoint is loaded (if `--no-resume` is not set and `--dry-run` is not set) — previously completed groups are filtered from the task list.

2. **Per-group agent loop** (one `run()` / `query()` call per key group):
   - `index.ts` calls `handlers.nextKeyGroup()` directly to get the next group.
   - A fresh AI agent is spawned for that group with only `commit_bundle` available (`maxTurns: 5`).
   - The group payload (normalized text, placeholders, domain, per-locale rules + translation memory) is passed in the prompt.
   - The agent translates all M locales in one reasoning turn and calls `commit_bundle` once.
   - `commit_bundle` runs server-side placeholder + locale validation, scores confidence, and writes atomically.
   - After `commit_bundle`, the group is recorded in the checkpoint and the loop advances.

3. **Termination:** when `handlers.nextKeyGroup()` returns `{group: null}`, `index.ts` calls `handlers.emitReport()` directly and exits.

---

## Why key groups?

For **N changed keys × M target locales**, the naive structure does N×M iterations end-to-end. Two optimisations collapse the work:

| Step | Naive | Key-group |
|---|---|---|
| `normalize_text` / `classify_domain` | N×M (recomputed per locale) | N (pre-flight, cached per source key) |
| Locale rules / translation memory lookup | N×M | N×M (locale-specific — unchanged) |
| Model translate round-trips | N×M (one per locale) | N (M translations in one reasoning turn per group) |
| `commit_bundle` calls | N×M | N (M updates batched per call) |

The dominant wall-clock win is collapsing N×M sequential model round-trips into N batched ones. Each group still gets a fresh agent call (no context leakage), and `commit_bundle` validates and scores per locale server-side.

---

## Extending the pipeline

### Adding a new MCP tool

1. Add the handler signature to `ToolHandlers` in `agent/tools-core.ts` and implement it inside `makeHandlers`.
2. Register the tool in **both** providers:
   - `agent/tools-openai.ts` — add to `allTools` with `tool({ name, description, parameters: ZodSchema, execute })`. Use `.nullable().optional()` for optional fields (GPT may pass `null`). Pass the new tool to the agent in `index.ts` if you want it exposed.
   - `agent/tools-anthropic.ts` — add with `tool(name, description, params, handler)`. Add `mcp__localizer__<name>` to `allowedTools` in `index.ts` if you want the agent to use it.
3. Document the tool in `prompts/role.md` or the inline task instruction in `buildGroupSystemPrompt` (the agent only does what the prompt directs).

### Adding a new provider

The handler logic in `tools-core.ts` is provider-agnostic. To add a third provider:

1. Create `agent/tools-<provider>.ts` that consumes `makeHandlers(deps)` and wraps each handler in the provider's tool format.
2. Add a `run<Provider>Group` function in `agent/index.ts` (model the streaming/event loop on the existing two).
3. Extend `detectProvider` to recognise the new API key.

### Adding or editing locale rules

Locale-specific grammar, spelling, anti-patterns, and structure rules live in `data/locale-rules.json`. The `get_locale_rules` logic is baked into the group payload returned by `nextKeyGroup`. Adding a new locale is a JSON edit, no code change. The `lib/locale-validator.ts` checks are separate — extend that file if you need new automated validators (e.g., a new placeholder dialect).

### Modifying the prompts

The per-group system prompt is assembled by `agent/system-prompt.ts` from these files:

- `prompts/role.md` — agent identity and constraints
- `prompts/placement.md` — per-placement constraints (button length, error tone, etc.)
- `prompts/safety.md` — non-negotiable invariants

`prompts/loop.md` and `prompts/pipeline.md` are used only by the legacy `buildSystemPrompt` function.

Be conservative with prompt edits — they directly shape agent behaviour, and regressions in reasoning are hard to catch without end-to-end runs.

---

## Build and packaging

`npm run build` runs `tsc && node scripts/copy-assets.mjs`. The asset copy step mirrors `data/` and `prompts/` into `dist/data/` and `dist/prompts/` so the compiled binary can resolve them at the same `../data` / `../prompts` paths it uses in dev. The `files` whitelist in `package.json` ships only `dist/`, so the runtime assets travel with the binary.

`prepublishOnly` triggers `npm run build` automatically so `npm publish` cannot ship a binary without its assets.

---

## Testing

```bash
npm test                                              # run all unit + integration tests
npm run typecheck                                     # type-check without emitting
npm run build                                         # verify build still compiles
npx tsx scripts/smoke-preflight.ts fixtures/sample-repo  # smoke-test pre-flight
npx tsx scripts/smoke-mcp.ts                          # smoke-test MCP handler wiring
```

Unit tests live in `test/lib/` and cover every `lib/` module. Integration tests in `test/integration/` exercise the locale writer and the full pre-flight pipeline against `fixtures/sample-repo`.

For changes that affect agent behaviour, run an end-to-end with `--dry-run` against a representative repo and inspect the report.

---

## Conventions

- Run `npm run typecheck` before committing.
- `noUncheckedIndexedAccess` is on — handle `undefined` from index lookups explicitly.
- Locale files must be valid JSON with an object at the root; loaders also accept `allowTrailingComma`.
- New code that persists to locale files must go through `commit_bundle` / `commitBundleUpdates` — never call `fs.writeFile` on a locale path directly.
- Keep prompt edits separate from code edits in PRs so reviewers can audit each independently.
