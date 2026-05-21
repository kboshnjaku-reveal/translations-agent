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
```

`npm run build` produces a publishable layout in `dist/`. The `scripts/copy-assets.mjs` step is required because `tsc` only emits TypeScript output — runtime assets (`data/`, `prompts/`) have to be mirrored alongside the compiled JS so the binary can resolve them at install time.

---

## Project layout

```
translations-agent/
├── agent/
│   ├── index.ts            CLI entry — flag parsing, pre-flight, provider selection, agent launch
│   ├── tools-core.ts       Shared MCP handler logic + type definitions
│   ├── tools-openai.ts     OpenAI tool builder (Zod schemas + @openai/agents tool() wrappers)
│   ├── tools-anthropic.ts  Anthropic tool builder (createSdkMcpServer)
│   ├── system-prompt.ts    Stitches prompts/*.md + run context into the agent's instructions
│   ├── repository.ts       Scans the repo for locale bundles
│   ├── git.ts              Computes changed source-locale keys via simple-git
│   ├── work-queue.ts       Materialises (key × locale) tasks with cached pre-computation
│   └── locale-writer.ts    Atomic JSON merge + tmp/rename — the ONLY code that writes locale files
├── lib/                    Pure functions (placeholders, glossary, classifier, scorer, validator, trace)
├── prompts/                Markdown templates composed into the system prompt
├── data/                   Static glossary seed and per-locale rules
├── scripts/                Build helpers and smoke tests
└── fixtures/sample-repo/   Minimal git repo used by the smoke tests
```

See [CLAUDE.md](CLAUDE.md) for the file-by-file map of every export and the key invariants the codebase relies on.

---

## How a run works (short version)

1. **Pre-flight** (deterministic, no AI):
   - `repository.scanRepository` finds locale bundles by globbing for `**/locales|i18n|translations|messages/**/*.json`.
   - `git.detectChangedKeys` diffs each source locale file against `HEAD` and emits `{keyPath, oldValue, newValue, status}` per change.
   - `work-queue.buildWorkQueue` produces tasks (cartesian product of changes × target locales), caching `maskPlaceholders` and `classifyDomain` once per source key.
   - `lib/glossary.buildGlossary` mines a project-specific glossary from existing translations and merges with `data/glossary-seed.json`.
2. **Agent loop** (one `run()` / `query()` call):
   - The agent dequeues key groups via `next_key_group`. A group is one source key plus every target locale that needs it translated.
   - Shared steps (`normalize_text`, `classify_domain`) run once per group; per-locale steps (`search_glossary`, `get_locale_rules`, `validate_translation`, `score_confidence`) run once per locale.
   - All M locale translations are produced in a single reasoning turn, then validated and scored individually.
   - One `commit_bundle` call per group persists all M updates atomically.
3. **Termination:** when `next_key_group()` returns `{group: null}`, the agent calls `emit_report` and stops.

---

## Why key groups?

For **N changed keys × M target locales**, the naive structure does N×M iterations end-to-end. Two optimisations collapse the work:

| Step | Naive | Key-group |
|---|---|---|
| `normalize_text` / `classify_domain` | N×M (recomputed per locale) | N (pre-flight, cached per source key) |
| `search_glossary` / `get_locale_rules` | N×M | N×M (locale-specific — unchanged) |
| Model translate round-trips | N×M (one per locale) | N (M translations in one reasoning turn) |
| `commit_bundle` calls | N×M | N (M updates batched per call) |

The dominant wall-clock win is collapsing N×M sequential model round-trips into N batched ones. Trace tokens still validate per locale — shared steps fan their token to every group member so each locale's `validate_translation` sees the full chain.

---

## Extending the pipeline

### Adding a new MCP tool

1. Add the handler signature to `ToolHandlers` in `agent/tools-core.ts` and implement it inside `makeHandlers`.
2. Register the tool in **both** providers:
   - `agent/tools-openai.ts` — wrap with `tool({ name, description, parameters: ZodSchema, execute })`. Use `.nullable().optional()` for optional fields (GPT may pass `null`).
   - `agent/tools-anthropic.ts` — wrap with `tool(name, description, params, handler)`. Append `mcp__localizer__<name>` to `toolNames`.
3. If the tool participates in the trace-token chain, add the step to `TraceStep` in `lib/trace.ts` and include it in `REQUIRED_PRE_VALIDATE` if it must run before `validate_translation`.
4. Document the tool in `prompts/pipeline.md` (the agent only does what the prompt directs).

### Adding a new provider

The handler logic in `tools-core.ts` is provider-agnostic. To add a third provider:

1. Create `agent/tools-<provider>.ts` that consumes `makeHandlers(deps)` and wraps each handler in the provider's tool format.
2. Add a `run<Provider>` function in `agent/index.ts` (model the streaming/event loop on the existing two).
3. Extend `detectProvider` to recognise the new API key.

### Adding or editing locale rules

Locale-specific grammar, spelling, anti-patterns, and structure rules live in `data/locale-rules.json`. The `get_locale_rules` MCP tool serves these to the agent. Adding a new locale is a JSON edit, no code change. The `lib/locale-validator.ts` checks are separate — extend that file if you need new automated validators (e.g., a new placeholder dialect).

### Modifying the prompts

The system prompt is assembled by `agent/system-prompt.ts` from these files (order matters):

- `prompts/role.md` — agent identity and constraints
- `prompts/loop.md` — the main state machine
- `prompts/pipeline.md` — the 8-step pipeline spec
- `prompts/placement.md` — per-placement constraints (button length, error tone, etc.)
- `prompts/safety.md` — non-negotiable invariants

Be conservative with prompt edits — they directly shape agent behaviour, and there is no test suite that catches regressions in agent reasoning today (see #17 in the backlog).

---

## Build and packaging

`npm run build` runs `tsc && node scripts/copy-assets.mjs`. The asset copy step mirrors `data/` and `prompts/` into `dist/data/` and `dist/prompts/` so the compiled binary can resolve them at the same `../data` / `../prompts` paths it uses in dev. The `files` whitelist in `package.json` ships only `dist/`, so the runtime assets travel with the binary.

`prepublishOnly` triggers `npm run build` automatically so `npm publish` cannot ship a binary without its assets.

---

## Testing

Today there are smoke scripts (`scripts/smoke-preflight.ts`, `scripts/smoke-mcp.ts`) but no `npm test`. Unit + golden-fixture tests are tracked as a backlog item. Before opening a PR, run:

```bash
npm run typecheck
npm run build
npx tsx scripts/smoke-preflight.ts fixtures/sample-repo
npx tsx scripts/smoke-mcp.ts
```

For changes that affect agent behaviour, run an end-to-end with `--dry-run` against a representative repo and inspect the report.

---

## Conventions

- Run `npm run typecheck` before committing.
- `noUncheckedIndexedAccess` is on — handle `undefined` from index lookups explicitly.
- Locale files must be valid JSON with an object at the root; loaders also accept `allowTrailingComma`.
- New code that persists to locale files must go through `commit_bundle` / `commitBundleUpdates` — never call `fs.writeFile` on a locale path directly.
- Keep prompt edits separate from code edits in PRs so reviewers can audit each independently.
