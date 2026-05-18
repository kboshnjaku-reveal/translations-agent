# 8-Step Translation Pipeline

For each task pulled from `next_task()`, execute the following steps **in order**. Pass the previous step's `traceToken` into the next step. Collect all four pre-validate tokens (normalize, glossary, classify, locale_rules) into `traceTokens[]` for `validate_translation`.

1. **normalize_text** — call with `{taskId, text: task.newValue}`. Records placeholders and returns a masked string. Save: `placeholders`, `normalized`, `traceToken`.

2. **search_glossary** — call with `{taskId, text: task.newValue, sourceLocale: task.sourceLocale, targetLocale: task.targetLocale, traceToken: <from step 1>}`. Apply matches verbatim:
   - `keepEnglish: true` → keep the term **exactly as in English**.
   - `keepEnglish: false` → use the glossary `translation` exactly.
   Do not invent glossary entries beyond what this tool returns.

3. **classify_domain** — call with `{taskId, text: task.newValue, traceToken: <from step 2>}`. Returned domain informs tone: legal/eDiscovery → conservative, formal; tech → product-UI conventional.

4. **get_locale_rules** — call with `{taskId, locale: task.targetLocale, placement: task.placement, traceToken: <from step 3>}`. The response defines required formality, spelling, anti-patterns, and placement constraints (e.g. button = ≤3 words, action-led, no punctuation).

5. **Translate** — produce the translation *yourself*. No tool call. Requirements:
   - Apply glossary matches exactly.
   - Follow locale rules and placement constraints from step 4.
   - Preserve every placeholder (`{{var}}`, `{var}`, `${var}`, `%s`, `%d`) verbatim and in the same order.
   - Preserve ICU plural/select syntax (`{count, plural, one {…} other {…}}`).
   - Preserve HTML/XML tags, escape sequences, and inline formatting.
   - Preserve intent and tone, not just words.
   - For domain `Legal` or `eDiscovery`: prefer conservative, formal phrasing; do not paraphrase aggressively.

6. **validate_translation** — call with `{taskId, source: task.newValue, translation: <your candidate>, locale: task.targetLocale, placeholders: <from step 1>, traceTokens: [<normalize>, <glossary>, <classify>, <locale_rules>]}`. If `valid === false`, read the `issues` array — each issue has a `code` and `expected`/`actual`. Fix the translation against the named issue and re-call validate. **Self-correction budget: at most 2 retries.** On the 3rd failure, escalate to step 8b (review path).

7. **WebSearch (conditional)** — only when web validation is enabled and the content is ambiguous, marketing, or legal-critical. Search authoritative sources:
   - Standard product UI: Microsoft, Google, Apple, Slack
   - Legal/eDiscovery: Relativity, Everlaw, law-firm style guides, bar associations
   Require ≥2 authoritative sources to agree before accepting. Convert search certainty into a `webScore` in [0, 1]: 1.0 if ≥2 sources confirm; 0.6 if 1 source; 0.0 if conflicting evidence. If web validation is disabled for this run, skip step 7 and omit `webScore` in step 8.

8. **score_confidence** — call with `{taskId, webScore?, localeScore: <from step 6>, structureScore: <from step 6>}`. The returned `tier`:
   - `auto` — write normally via `commit_bundle` with `needsReview: false`.
   - `optional` — write normally but be slightly more cautious; still `needsReview: false` unless you have specific doubts.
   - `escalate` or `mandatory` — proceed to **8b**.

   **8b. Review path:** call `commit_bundle` with `needsReview: true` and a short `failureReason`. The translation is still written (best-effort) plus a sibling `<keyPath>__needsReview` key. Move on to the next task.

After every task: call `commit_bundle` for that task with a single-element `updates` array. (Batching is allowed only if multiple tasks targeting the same bundle have been completed back-to-back, but never delay a write across tasks for different bundles.)
