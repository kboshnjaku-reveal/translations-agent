# translations-agent — Developer Guide

This repo builds a CLI tool (`translations-agent`) that runs *inside another git repo* and automates localization updates. It is **not** a general coding agent. All behaviour is deterministic pre-flight + an AI-driven loop that processes one key group per agent call.

---

## Architecture in one breath

A Node CLI does deterministic pre-flight (scan → git-diff → flatten work queue → build glossary → load/save checkpoint), then drives an outer loop in `index.ts`. For each key group, it calls `handlers.nextKeyGroup()` directly, then spawns a fresh AI agent call with only `commit_bundle` available. The agent translates all target locales for that group in one reasoning turn and calls `commit_bundle` once. After all groups are processed, `index.ts` calls `handlers.emitReport()` directly. The agent never sees `next_key_group` or `emit_report`; it only calls `commit_bundle`.

---

## Where things live

### agent/
| File | Purpose |
|---|---|
| [agent/index.ts](agent/index.ts) | CLI entry: flag parsing, permission prompt, pre-flight, glossary build (`--glossary`), checkpoint load/save, per-group agent loop (with glossary bypass), token ledger update, HTML report write, exit |
| [agent/tools.ts](agent/tools.ts) | Re-export shim — delegates to `tools-openai.ts` or `tools-anthropic.ts` |
| [agent/tools-core.ts](agent/tools-core.ts) | Shared MCP handler logic (`makeHandlers(deps)`), all type definitions (`Task`, `Update`, `ReportStats`, HTML report types); `ServerDeps` includes `glossary?: GlossaryEntry[]` and `resolvedFromGlossary?: Set<string>` for the glossary bypass fast path |
| [agent/tools-openai.ts](agent/tools-openai.ts) | `buildOpenAITools(deps)` → `{tools, toolNames, handlers, commitTool}` — wraps handlers as `@openai/agents` `tool()` objects; `index.ts` passes only `commitTool` to the agent |
| [agent/tools-anthropic.ts](agent/tools-anthropic.ts) | `buildAnthropicServer(deps)` → `{server, toolNames, handlers}` — wraps handlers in `createSdkMcpServer()`; `index.ts` restricts `allowedTools` to `commit_bundle` only |
| [agent/system-prompt.ts](agent/system-prompt.ts) | `buildGroupSystemPrompt(ctx)` — per-group prompt (role + task instruction + placement + safety); `buildSystemPrompt(ctx)` — legacy full-loop prompt (not currently used) |
| [agent/repository.ts](agent/repository.ts) | Scans repo for locale bundles (directories containing source-locale JSON) |
| [agent/git.ts](agent/git.ts) | `detectChangedKeys()` — compares HEAD vs. working tree via `simple-git`; `ensureCleanGitState()`, `getHeadSha()`, `isGitRepo()` |
| [agent/work-queue.ts](agent/work-queue.ts) | `buildWorkQueue()` — cartesian product of (changed keys × target locales) with placement inference and pre-computed normalization/classification |
| [agent/locale-writer.ts](agent/locale-writer.ts) | Atomic JSON merge + temp-file rename. **The only code that writes locale files.** |
| [agent/html-report.ts](agent/html-report.ts) | `writeHtmlReport(root, report)` — generates and writes a self-contained HTML report to `reports/translation-report-YYYYMMDD-HHMMSS.html` |
| [agent/web-search-batch.ts](agent/web-search-batch.ts) | `runBatchWebSearch(queries, webSearchByTaskId)` — fires OpenAI web search for all locales in a group simultaneously; populates the `webSearchByTaskId` map used by the HTML report |

### lib/ — pure functions, no AI calls, easy to unit-test
| File | Key exports |
|---|---|
| [lib/flatten-json.ts](lib/flatten-json.ts) | `flatten(obj)` → `FlatEntry[]`, `setDeep(target, keyPath, value)`, `getDeep(source, keyPath)` |
| [lib/placeholders.ts](lib/placeholders.ts) | `maskPlaceholders(text)`, `unmaskPlaceholders(masked, ph[])`, `comparePlaceholders(src, tgt)` |
| [lib/glossary.ts](lib/glossary.ts) | `buildGlossary(sources, sourceLocale)`, `findMatches(glossary, text, targetLocale)`, `findExactMatch(glossary, text, targetLocale)` |
| [lib/domain-classifier.ts](lib/domain-classifier.ts) | `classifyDomain(text)` → `{domain, confidence, hits}` |
| [lib/confidence-scorer.ts](lib/confidence-scorer.ts) | `scoreConfidence({webScore?, localeScore, structureScore})` → `{total, tier, components}` |
| [lib/locale-validator.ts](lib/locale-validator.ts) | `validateLocale(translation, locale)` → `{issues[], score}` |
| [lib/trace.ts](lib/trace.ts) | `TraceRegistry` — issues and verifies pipeline step tokens (reserved for future use) |
| [lib/checkpoint.ts](lib/checkpoint.ts) | `loadCheckpoint`, `saveCheckpoint`, `deleteCheckpoint`, `isCheckpointValid`, `digestContents` — crash-resume state stored at `.translations-agent/state.json` |

### Other directories
| Path | Purpose |
|---|---|
| [prompts/](prompts/) | Markdown templates composed into the system prompt: `role.md`, `loop.md`, `pipeline.md`, `placement.md`, `safety.md`. Only `role.md`, `placement.md`, `safety.md` are used by the current `buildGroupSystemPrompt`. |
| [data/locale-rules.json](data/locale-rules.json) | Static per-locale rules (formality, spelling, anti-patterns) + per-placement constraints |
| [scripts/](scripts/) | `smoke-preflight.ts` (pre-flight pipeline test), `smoke-mcp.ts` (MCP handler test), `copy-assets.mjs` (build asset copy) |
| [fixtures/sample-repo/](fixtures/sample-repo/) | Minimal git repo with locale files — used by smoke tests and integration tests |
| [test/lib/](test/lib/) | Unit tests for all `lib/` modules (`confidence-scorer`, `domain-classifier`, `flatten-json`, `glossary`, `locale-validator`, `placeholders`, `trace`) |
| [test/integration/](test/integration/) | Integration tests: `locale-writer.test.ts`, `preflight.test.ts` |

---

## Handler interface vs. MCP tools

All three handlers live in `tools-core.ts` via `makeHandlers(deps)`. How they are exposed differs by execution path:

| Handler | Exposed to agent as MCP tool? | Who calls it |
|---|---|---|
| `nextKeyGroup()` | No | `index.ts` outer loop (directly) |
| `commitBundle({bundleId, updates})` | **Yes** — the only tool the agent sees | AI agent (via `commit_bundle` MCP call) |
| `emitReport()` | No | `index.ts` after the loop ends |

The MCP server (`createSdkMcpServer`) and `allTools` array in the provider builders contain all three tool definitions, but `index.ts` restricts the agent to `commit_bundle` only:
- **OpenAI**: passes `commitTool` (not `allTools`) when constructing the `Agent`
- **Anthropic**: sets `allowedTools: ["mcp__localizer__commit_bundle"]` in `query()`

**`Update` shape** (element of `commit_bundle.updates`):
```typescript
{ targetLocale: string; keyPath: string; value: string; needsReview: boolean; failureReason?: string }
```

---

## Key invariants

1. **No raw writes.** The agent has no Write/Edit tool for locale JSON. All persistence goes through `commit_bundle`, which runs server-side placeholder structure checks and locale validation before writing. This is the only code path that can corrupt locale files — keep its parser strict.
2. **Pre-flight materialises the work queue.** `index.ts` drives the outer loop and calls `handlers.nextKeyGroup()` directly — there is no nested loop inside the agent.
3. **Confidence < 0.85** → server writes best-effort translation AND a sibling `<key>__needsReview: true`. Never silently drop a key.
4. **Multi-bundle.** Each directory containing a source-locale file is an independent bundle. Bundles are computed in `repository.ts`.
5. **Source locale priority:** `en.json` > `en-US.json` > first English-looking file > `--source-locale` override.
6. **Fresh agent per key group.** One `run()` (OpenAI) or `query()` (Anthropic) per key group; `maxTurns: 5`. No context leaks between groups.
7. **Checkpoint invalidation.** If the HEAD SHA or any source file digest changes between runs, the saved checkpoint is discarded and the run starts fresh.

---

## Provider details

### OpenAI (`@openai/agents`)
- Builder: `buildOpenAITools(deps)` → `{tools, toolNames, handlers, commitTool}`
- Each tool: `tool({name, description, parameters: ZodSchema, execute})`
- Nullable optional fields in Zod schemas — GPT may send `null` for optional args
- Per-group execution: `new Agent({instructions, model, tools: [commitTool]})` then `run(agent, prompt, {stream: true, maxTurns: 5})`
- Default model: `gpt-4o-mini`

### Anthropic (`@anthropic-ai/claude-agent-sdk`)
- Builder: `buildAnthropicServer(deps)` → `{server, toolNames, handlers}`
- Tool names are prefixed `mcp__localizer__*` in the `toolNames` array
- Per-group execution: `query({prompt, options: {model, systemPrompt, mcpServers: {localizer: server}, allowedTools: ["mcp__localizer__commit_bundle"], maxTurns: 5}})`
- Default model: `claude-opus-4-7`

Both share `makeHandlers(deps)` from `tools-core.ts`.

---

## System prompt composition

`buildGroupSystemPrompt(ctx)` in [agent/system-prompt.ts](agent/system-prompt.ts) is the active function used for each per-group agent call. It composes:

1. `prompts/role.md` — agent identity and constraints
2. Inline task instruction: translate all locales in the received group, call `commit_bundle` once, then stop
3. `prompts/placement.md` — per-placement word/length constraints (button ≤3 words, error = one sentence, etc.)
4. `prompts/safety.md` — non-negotiable invariants

`buildSystemPrompt(ctx)` (also in `system-prompt.ts`) is a legacy full-loop variant that includes `prompts/loop.md` and `prompts/pipeline.md`. It is retained but not called by `index.ts` in the current architecture.

---

## Checkpoint / resume

On each non-dry-run, non-`--no-resume` run:
1. `index.ts` saves a checkpoint to `.translations-agent/state.json` before the agent loop starts. The checkpoint records the current HEAD SHA, a SHA-256 digest of each source file, and a list of completed `{bundleId, keyPath}` groups.
2. After each successful `commit_bundle`, the `onGroupCommitted` callback appends the group to the checkpoint and re-saves it.
3. On the next run, if the checkpoint HEAD SHA and source digests still match, completed groups are filtered out of the task list and skipped.
4. On successful completion, the checkpoint is deleted. On a stale checkpoint (source changed), it is replaced.
5. `--no-resume` skips loading the checkpoint. Progress is still saved unless `--dry-run` is also set.

---

## Confidence tiers

Computed by `scoreConfidence()`. Weighting strategy:
- **Web enabled:** `web×0.45 + locale×0.4 + structure×0.15`
- **Web disabled:** `locale×0.4 + structure×0.15` renormalised to 1.0 (`locale×0.727 + structure×0.273`)

| Tier | Score | Behaviour |
|---|---|---|
| `auto` | > 0.95 | Write directly |
| `optional` | ≥ 0.85 | Write, no flag |
| `escalate` | ≥ 0.70 | Write + `__needsReview: true` |
| `mandatory` | < 0.70 | Write + `__needsReview: true` |

---

## Locale validator checks

`validateLocale(translation, locale)` in `lib/locale-validator.ts`:
- **de:** Sie-form only (no du/dich/dir), ß per orthography, avoid English loanwords
- **nl:** u-form (no je/jij), ij digraph (no bare y), avoid Anglicisms
- **es:** inverted punctuation ¿¡, no voseo, avoid Latin American vocabulary
- **it:** formal Lei-form (no tu-forms)
- **da/fi/sv:** ASCII substitutions for locale-specific special characters (high-confidence cases)

Score = `1.0 − (issues.length × 0.15)`, floored at 0.

---

## Build & dev commands

```bash
npm install               # install dependencies (Node ≥ 20 required)
npm run dev               # run via tsx, no build step
npm run build             # tsc → dist/ + copy-assets.mjs mirrors data/ and prompts/
npm run typecheck         # type-check without emitting
npm test                  # node --test --import tsx/esm test/**/*.test.ts

# Smoke tests (run from repo root):
npx tsx scripts/smoke-preflight.ts [path-to-target-repo]
npx tsx scripts/smoke-mcp.ts
```

Development entry point: `npx tsx agent/index.ts`
Production binary (after build): `translations-agent`

### Container (Podman / Docker)

A `Dockerfile` and `docker-compose.yml` are included. The image is multi-stage (Debian slim): the builder stage compiles TypeScript; the runner stage installs production deps only and adds `git` for `simple-git`.

```bash
# Build the image
podman build -t translations-agent .

# Run against a target repo (replace path and key)
podman run --rm \
  -v /path/to/your-app:/repo \
  -e ANTHROPIC_API_KEY=sk-ant-your-key-here \
  localhost/translations-agent --yes

# Or with podman-compose (set REPO to the absolute path of the target repo)
REPO=/path/to/your-app podman-compose run --rm agent --yes
```

`--yes` is required — the interactive permission prompt cannot be answered inside a container.

---

## Environment variables

| Variable | Effect |
|---|---|
| `OPENAI_API_KEY` | Selects OpenAI provider (default model: `gpt-4o-mini`). |
| `ANTHROPIC_API_KEY` | Selects Anthropic provider (default model: `claude-opus-4-7`). |
| `DEBUG_TRACE=1` | Reserved for future verbose MCP tool logging — not yet wired into code |

If both API keys are set, the CLI prompts for a choice at startup. Copy `.env.example` → `.env` and set one key.

---

## Debugging tips

| Symptom | Where to look |
|---|---|
| Wrong translations | Check what locale rules `commit_bundle` applied — rules come from `data/locale-rules.json` keyed by target locale |
| Agent only calls commit_bundle | Expected — `next_key_group` and `emit_report` are called directly by `index.ts`, not by the agent |
| `commit_bundle` rejects everything | Server-side placeholder check is failing — a `{{var}}` was lost during translation |
| Unexpected work queue | Work queue is printed to stdout at pre-flight end before the agent loop starts — inspect it there |
| Provider not selected | Confirm the correct key is exported; both keys being set triggers the interactive choice prompt |
| Checkpoint not resuming | HEAD SHA or source file contents changed since last run — checkpoint is discarded automatically |
| `Agent finished without emitting a report` | `finalReport` was never set; check for errors in `commit_bundle` calls or agent `maxTurns` exhaustion |

---

## What this tool will NOT do

- Modify application code, refactor, or rename keys.
- Translate from a non-source locale.
- Delete existing keys.
- Re-translate keys whose values did not change.
- Stay interactive — it exits after one run by design.
