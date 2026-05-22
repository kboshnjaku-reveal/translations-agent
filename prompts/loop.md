# Loop Contract

Run this loop until the queue is empty:

```
while true:
  resp = next_key_group()
  if resp.group is null: break
  group = resp.group
  # group = {
  #   groupId, bundleId, sourceLocale, keyPath, newValue,
  #   normalized, placeholders, domain, status, placement,
  #   locales: [ { taskId, targetLocale, rules, placementConstraint, tm }, ... ]
  # }

  # ── Translate ALL locales in ONE reasoning turn ──
  # Use group.normalized + group.placeholders + each locale's rules, placementConstraint, and tm.
  # Produce a {targetLocale: translation} map. No tool call needed.
  #
  # For MODIFIED groups (group.status == "modified"):
  #   If tm.oldTarget is non-null, start from tm.oldTarget and apply only the
  #   changes described by tm.sourceDiff. Preserve unaffected phrases verbatim.
  # For ADDED groups (group.status == "added"):
  #   Translate group.newValue normally following locale rules.
  translations = produce_all_translations(group)

  # ── ONE commit per group ──
  updates = []
  for each L in group.locales:
    updates.append({
      targetLocale: L.targetLocale,
      keyPath: group.keyPath,
      value: translations[L.targetLocale],
      needsReview: false,           # set true if you have specific quality concerns
      failureReason: null,          # short reason string if needsReview is true
    })
  commit_bundle({ bundleId: group.bundleId, updates: updates })

  # then loop back to next_key_group()

emit_report()
STOP
```

Rules:

- **One key group per iteration.** Translate every locale for that key before moving on.
- **All context is in the group.** `next_key_group` returns normalized text, placeholders, domain, locale rules, placement constraints, and translation memory — no additional tool calls needed before translating.
- **Batch the translate step.** Produce all M translations in a single reasoning turn — do not return to the loop between locales.
- **Translation memory for modified keys.** When `group.status === "modified"` and `tm.oldTarget` is non-null, start from `oldTarget` and apply only the changes described by `sourceDiff`. Do not retranslate from scratch — that churns clean copy.
- **Server handles validation and scoring.** The server validates placeholder structure and locale rules in `commit_bundle`, computes confidence, and sets `needsReview` automatically when confidence is low. You only need to set `needsReview: true` when you have qualitative concerns the automated checks would not catch.
- **One commit per group.** `commit_bundle` is called once with one entry in `updates` per locale.
- **Group isolation.** Do not let text or context from a prior group leak into a different group's translations.
- **Termination.** When `next_key_group()` returns `{group: null}`, call `emit_report()` exactly once, then stop.
