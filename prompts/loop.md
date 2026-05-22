# Loop Contract

Run this loop until the queue is empty:

```
while true:
  resp = next_key_group()
  if resp.group is null: break
  group = resp.group
  # group = { groupId, bundleId, sourceLocale, keyPath, newValue, status,
  #           placement, locales: [ {taskId, targetLocale}, ... ] }

  # ── Group-shared steps (call ONCE per group) ──
  # Use ANY member taskId — e.g. group.locales[0].taskId.
  # The returned traceTokens are valid for every locale in the group.
  norm = normalize_text({ taskId: group.locales[0].taskId, text: group.newValue })
  cls  = classify_domain({ taskId: group.locales[0].taskId, text: group.newValue,
                           traceToken: norm.traceToken })

  # ── Per-locale prep (issue ALL calls in a single parallel response) ──
  # PARALLELISM: emit get_locale_rules for every locale simultaneously.
  # If group.status == "modified", also emit translation_memory for every locale simultaneously
  # in a separate parallel response before get_locale_rules.
  prep = {}   # targetLocale → { rulesToken, rules, placementConstraint, tm }
  # [parallel] for each L in group.locales:
    r = get_locale_rules({ taskId: L.taskId, locale: L.targetLocale,
                           placement: group.placement,
                           traceToken: cls.traceToken })
    # Translation memory: fetch prior source + translation for modified keys.
    tm = null
    if group.status == "modified":
      tm = translation_memory({ taskId: L.taskId, targetLocale: L.targetLocale })
    prep[L.targetLocale] = { r, tm }

  # ── Translate ALL locales in ONE reasoning step ──
  # Produce a {targetLocale: translation} map. This is your ONE chance to
  # batch translations — do not return to the loop between locales.
  #
  # For MODIFIED groups (group.status == "modified"):
  #   If tm.oldTarget is non-null, start from tm.oldTarget and apply only the
  #   changes described by tm.sourceDiff. Preserve unaffected phrases verbatim.
  #   This is preferable to retranslating from scratch, which churns clean copy.
  # For ADDED groups (group.status == "added"):
  #   Translate group.newValue normally following locale rules.
  translations = produce_all_translations(group, prep)

  # ── Per-locale validate + score (issue ALL validate calls in one parallel response,
  #    then ALL score calls in one parallel response) ──
  updates = []
  # [parallel] for each L in group.locales — validate:
    candidate = translations[L.targetLocale]
    for attempt in 1..3:
      v = validate_translation({
        taskId: L.taskId, source: group.newValue, translation: candidate,
        locale: L.targetLocale, placeholders: norm.placeholders,
        traceTokens: [ norm.traceToken, cls.traceToken, prep[L.targetLocale].r.traceToken ],
      })
      if v.valid: break
      candidate = fix_against_issues(candidate, v.issues)   # produce a corrected candidate
  # [parallel] for each L in group.locales — score:
    s = score_confidence({ taskId: L.taskId,
                           localeScore: v.localeScore,
                           structureScore: v.structureScore })
    needsReview = (s.tier == "escalate") or (s.tier == "mandatory") or (not v.valid)
    updates.append({
      targetLocale: L.targetLocale,
      keyPath: group.keyPath,
      value: candidate,
      needsReview: needsReview,
      failureReason: short_reason if needsReview else null,
    })

  # ── ONE commit per group ──
  commit_bundle({ bundleId: group.bundleId, updates: updates })

  # then loop back to next_key_group()

emit_report({ stats: JSON.stringify(your_tally) })
STOP
```

Rules:

- **One key group per iteration.** Translate every locale for that key before moving on.
- **Shared steps run once.** `normalize_text` and `classify_domain` are called exactly once per group; their `traceToken`s are valid for every locale in the group's `locales` array.
- **Per-locale steps run in parallel.** Issue all `get_locale_rules`, all `validate_translation`, and all `score_confidence` calls simultaneously — one response per step, not one API call per locale.
- **Batch the translate step.** Produce all M translations in a single reasoning turn — do not return to the loop between locales.
- **Translation memory for modified keys.** When `group.status === "modified"` and `tm.oldTarget` is non-null, start from `oldTarget` and apply only the changes described by `sourceDiff`. Do not retranslate from scratch — that churns clean copy and risks unnecessary review flags.
- **Per-locale retries.** If `de` validates clean but `fr` fails, retry only `fr`. Maximum 3 validate calls per locale; after the third failure, mark that locale `needsReview: true` and continue.
- **One commit per group.** `commit_bundle` is called once with one entry in `updates` per locale.
- **Group isolation.** Do not let text or context from a prior group leak into a different group's translations.
- **Termination.** When `next_key_group()` returns `{group: null}`, call `emit_report` exactly once, then stop.
