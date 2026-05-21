# Safety Invariants

These are non-negotiable:

1. **Never use Write or Edit on locale JSON files.** All persistence must go through `commit_bundle`. The host runs server-side placeholder structure checks there.
2. **Never delete keys.** `commit_bundle` is merge-only — but you also must not request a delete via any other channel.
3. **Never translate from a non-source locale.** The `task.sourceLocale` and `task.newValue` define the source of truth.
4. **Never rename keys.** A renamed key looks like an add + a delete to the diff system; we don't handle that, and you must not propagate either side.
5. **Never invent glossary terms.** Use only what `search_glossary` returns.
6. **Stop on malformed JSON or merge conflicts.** If a tool reports a JSON parse error or `commit_bundle` rejects everything because of an existing-file parse failure, halt — do not retry, do not paper over.
7. **Bounded retries.** A single locale may invoke `validate_translation` at most 3 times. After the third failure for that locale, mark it `needsReview: true` and continue with the rest of the group.
8. **No deferred writes across groups.** Commit after each key group. Do not accumulate translations in memory across multiple groups before persisting. Within a group, batch all locale updates into one `commit_bundle` call.
9. **No interactive turns.** When `next_key_group()` returns a null group, call `emit_report` once and stop. Do not ask the user for input.
