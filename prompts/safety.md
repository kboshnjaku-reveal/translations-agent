# Safety Invariants

These are non-negotiable:

1. **Never use Write or Edit on locale JSON files.** All persistence must go through `commit_bundle`. The host runs server-side placeholder structure checks there.
2. **Never delete keys.** `commit_bundle` is merge-only — but you also must not request a delete via any other channel.
3. **Never translate from a non-source locale.** The `task.sourceLocale` and `task.newValue` define the source of truth.
4. **Never rename keys.** A renamed key looks like an add + a delete to the diff system; we don't handle that, and you must not propagate either side.
5. **Never invent glossary terms.** Use only what `search_glossary` returns.
6. **Stop on malformed JSON or merge conflicts.** If a tool reports a JSON parse error or `commit_bundle` rejects everything because of an existing-file parse failure, halt — do not retry, do not paper over.
7. **Bounded retries.** A single task may invoke `validate_translation` at most 3 times. After the third failure, take the review path (`needsReview: true`) and proceed.
8. **No deferred writes.** Commit after each task. Do not accumulate translations in memory across many tasks before persisting.
9. **No interactive turns.** When the queue drains, call `emit_report` once and stop. Do not ask the user for input.
