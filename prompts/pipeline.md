# Translation Pipeline (per key group)

Each `next_key_group()` returns one source key plus every target locale that needs it translated. Steps are labelled **SHARED** (call once per group) or **PER-LOCALE** (call once for each locale in `group.locales`).

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

   Save `tm` for use in step 5. If `tm.oldTarget` is null (key exists in source but not yet in target), fall back to translating from scratch.

## PER-LOCALE — call ONCE for each locale in `group.locales`

For each `L` in `group.locales`:

3. **search_glossary** — `{ taskId: L.taskId, text: group.newValue, sourceLocale: group.sourceLocale, targetLocale: L.targetLocale, traceToken: <classify token> }`. Apply matches verbatim:
   - `keepEnglish: true` → keep the term **exactly as in English**.
   - `keepEnglish: false` → use the glossary `translation` exactly.
   Do not invent glossary entries beyond what this tool returns.

4. **get_locale_rules** — `{ taskId: L.taskId, locale: L.targetLocale, placement: group.placement, traceToken: <glossary token> }`. The response defines required formality, spelling, anti-patterns, and placement constraints (e.g. button = ≤3 words, action-led, no punctuation).

## SHARED — one reasoning turn, M outputs

5. **Translate** — produce the translation for **every** locale in `group.locales` in a single reasoning turn. No tool call. Output a `{targetLocale: translation}` map. Requirements (apply per locale):
   - Apply that locale's glossary matches exactly.
   - Follow that locale's rules and placement constraints from step 4.
   - Preserve every placeholder (`{{var}}`, `{var}`, `${var}`, `%s`, `%d`) verbatim and in the same order.
   - Preserve ICU plural/select syntax (`{count, plural, one {…} other {…}}`).
   - Preserve HTML/XML tags, escape sequences, and inline formatting.
   - Preserve intent and tone, not just words.
   - For domain `Legal` or `eDiscovery`: prefer conservative, formal phrasing; do not paraphrase aggressively.

   **For MODIFIED groups** (`group.status === "modified"`): if `tm.oldTarget` is non-null, start from `tm.oldTarget` and apply only the edits described by `tm.sourceDiff`. Preserve all phrasing that has not changed in the English source. This surgical approach avoids churning clean copy and keeps review noise low. Only fall back to translating `group.newValue` from scratch if `tm.oldTarget` is null.

   **For ADDED groups** (`group.status === "added"`): translate `group.newValue` normally.

   Do **not** return to the agent loop between locales. Translate them all in one turn.

## PER-LOCALE — validate + score for each locale

For each `L` in `group.locales`, using that locale's candidate translation:

6. **validate_translation** — `{ taskId: L.taskId, source: group.newValue, translation: <candidate>, locale: L.targetLocale, placeholders: <from normalize>, traceTokens: [<normalize>, <L's glossary>, <classify>, <L's locale_rules>] }`. If `valid === false`, read the `issues` array — each issue has a `code` and `expected`/`actual`. Fix the translation against the named issue and re-call validate. **Self-correction budget: at most 2 retries per locale.** On the 3rd failure, take the review path (step 8b) for that locale and continue.

7. **WebSearch (conditional)** — only when web validation is enabled and the content is ambiguous, marketing, or legal-critical. Prefer calling with task metadata when supported by the tool:
   - `WebSearch({ taskId: L.taskId, targetLocale: L.targetLocale, query: "..." })`
   - If the tool accepts only `query`, call `WebSearch({ query: "..." })`.
   Search authoritative sources:
   - Standard product UI: Microsoft, Google, Apple, Slack
   - Legal/eDiscovery: Relativity, Everlaw, law-firm style guides, bar associations
   Require ≥2 authoritative sources to agree before accepting. Convert search certainty into a `webScore` in [0, 1]: 1.0 if ≥2 sources confirm; 0.6 if 1 source; 0.0 if conflicting evidence. If web validation is disabled for this run, skip step 7 and omit `webScore` in step 8.

8. **score_confidence** — `{ taskId: L.taskId, webScore?, localeScore: <from step 6>, structureScore: <from step 6> }`. The returned `tier`:
   - `auto` — include in the `updates` array with `needsReview: false`.
   - `optional` — include with `needsReview: false` unless you have specific doubts.
   - `escalate` or `mandatory` — include with `needsReview: true` and a short `failureReason` (step 8b).

   **8b. Review path:** still include the translation in the `updates` array, with `needsReview: true`. The locale-writer writes the best-effort translation plus a sibling `<keyPath>__needsReview` key. Do not drop the locale.

## Batched commit

9. **commit_bundle** — `{ bundleId: group.bundleId, updates: [ ...one entry per locale... ] }`. Call once per group. Updates with `needsReview: false` go through the server-side placeholder structure check; updates with `needsReview: true` bypass it. Then loop back to `next_key_group()`.
