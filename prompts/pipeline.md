# Translation Pipeline (per key group)

Each `next_key_group()` returns one source key plus every target locale that needs it translated. Steps are labelled **SHARED** (call once per group) or **PER-LOCALE** (call once for each locale in `group.locales`).

**Parallelism rule:** whenever a step is labelled PER-LOCALE, issue ALL those tool calls in a single response — do not wait for one locale before starting the next. This is critical for reducing latency and token usage.

## SHARED — call ONCE per group

Use any member's `taskId` (e.g. `group.locales[0].taskId`). The trace tokens you receive back are valid for every locale in the group.

1. **normalize_text** — `{ taskId, text: group.newValue }`. Records placeholders and returns a masked string. Save: `placeholders`, `normalized`, `traceToken`. Call once.

2. **classify_domain** — `{ taskId, text: group.newValue, traceToken: <from normalize> }`. Returned domain informs tone for every locale: legal/eDiscovery → conservative, formal; tech → product-UI conventional. Call once.

## PER-LOCALE — call ONCE for each locale in `group.locales` (MODIFIED groups only)

**Step 0 applies only when `group.status === "modified"`.**

0. **translation_memory** — `{ taskId: L.taskId, targetLocale: L.targetLocale }`. Fetches the prior translation context for this locale:
   - `oldSource`: what the English source string was before the change.
   - `oldTarget`: what is currently written in the target locale file for this key.
   - `sourceDiff`: a word-level summary of what was added or removed in English (e.g. `"removed: [delete]; added: [remove, permanently]"`).

   Issue ALL locales' `translation_memory` calls in a single parallel response. Save `tm` per locale. If `tm.oldTarget` is null, fall back to translating from scratch.

## PER-LOCALE — call ONCE for each locale in `group.locales`

Issue ALL of the following calls in a single parallel response (one `get_locale_rules` call per locale):

3. **get_locale_rules** — `{ taskId: L.taskId, locale: L.targetLocale, placement: group.placement, traceToken: <classify token> }`. The response defines required formality, spelling, anti-patterns, and placement constraints (e.g. button = ≤3 words, action-led, no punctuation).

## SHARED — one reasoning turn, M outputs

4. **Translate** — produce the translation for **every** locale in `group.locales` in a single reasoning turn. No tool call. Output a `{targetLocale: translation}` map. Requirements (apply per locale):
   - Follow that locale's rules and placement constraints from step 3.
   - Preserve every placeholder (`{{var}}`, `{var}`, `${var}`, `%s`, `%d`) verbatim and in the same order.
   - Preserve ICU plural/select syntax (`{count, plural, one {…} other {…}}`).
   - Preserve HTML/XML tags, escape sequences, and inline formatting.
   - Preserve intent and tone, not just words.
   - For domain `Legal` or `eDiscovery`: prefer conservative, formal phrasing; do not paraphrase aggressively.

   **For MODIFIED groups** (`group.status === "modified"`): if `tm.oldTarget` is non-null, start from `tm.oldTarget` and apply only the edits described by `tm.sourceDiff`. Preserve all phrasing that has not changed in the English source. Only fall back to translating `group.newValue` from scratch if `tm.oldTarget` is null.

   **For ADDED groups** (`group.status === "added"`): translate `group.newValue` normally.

   Do **not** return to the agent loop between locales. Translate them all in one turn.

## PER-LOCALE — validate + score for each locale

Issue ALL `validate_translation` calls in a single parallel response, then ALL `score_confidence` calls in a single parallel response.

For each `L` in `group.locales`, using that locale's candidate translation:

5. **validate_translation** — `{ taskId: L.taskId, source: group.newValue, translation: <candidate>, locale: L.targetLocale, placeholders: <from normalize>, traceTokens: [<normalize>, <classify>, <L's locale_rules>] }`. If `valid === false`, read the `issues` array — each issue has a `code` and `expected`/`actual`. Fix the translation against the named issue and re-call validate. **Self-correction budget: at most 2 retries per locale.** On the 3rd failure, take the review path (step 7b) for that locale and continue.

6. **WebSearch** — **required for every locale** when web validation is enabled. Do not skip it because a translation looks obvious. This step is for **evidence collection only** — the results are recorded in the run report and are not used in scoring. Call with task metadata:
   - `WebSearch({ taskId: L.taskId, targetLocale: L.targetLocale, query: "<translated term> <targetLocale> localization" })`
   - If the tool accepts only `query`, call `WebSearch({ query: "..." })`.
   Search authoritative sources (Microsoft, Google, Apple, Relativity, Everlaw, bar associations, etc.). Record what you find — it will appear in the report as reference links and evidence summaries.
   If web validation is disabled for this run, skip step 6 entirely.

7. **score_confidence** — `{ taskId: L.taskId, localeScore: <from step 5>, structureScore: <from step 5> }`. **Never pass `webScore`** — confidence is computed from locale and structure checks only. The returned `tier`:
   - `auto` — include in the `updates` array with `needsReview: false`.
   - `optional` — include with `needsReview: false` unless you have specific doubts.
   - `escalate` or `mandatory` — include with `needsReview: true` and a short `failureReason` (step 7b).

   **7b. Review path:** still include the translation in the `updates` array, with `needsReview: true`. The locale-writer writes the best-effort translation plus a sibling `<keyPath>__needsReview` key. Do not drop the locale.

## Batched commit

8. **commit_bundle** — `{ bundleId: group.bundleId, updates: [ ...one entry per locale... ] }`. Call once per group. Updates with `needsReview: false` go through the server-side placeholder structure check; updates with `needsReview: true` bypass it. Then loop back to `next_key_group()`.
