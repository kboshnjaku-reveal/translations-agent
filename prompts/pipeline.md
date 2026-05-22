# Translation Pipeline (per key group)

Each `next_key_group()` returns one source key plus every target locale that needs it translated — with **all context pre-computed server-side**. No intermediate tool calls are needed before translating.

## What `next_key_group` returns

```
group = {
  groupId, bundleId, sourceLocale, keyPath,
  newValue,        // original source string
  normalized,      // whitespace-collapsed, placeholders masked as __PH0__..__PHn__
  placeholders,    // [{ token: "__PH0__", original: "{{varName}}" }, ...]
  domain,          // "eDiscovery" | "Legal" | "Tech" | "general"
  status,          // "added" | "modified"
  placement,       // "button_or_menu_item" | "error_message" | ... | "unspecified"
  locales: [       // one entry per target locale
    {
      taskId,
      targetLocale,
      rules: { formality, spelling, antiPatterns[], structureRules[] },
      placementConstraint,   // word/length/style constraint for this placement, or null
      tm: {                  // translation memory — only non-null for status="modified"
        oldSource,           // previous English value
        oldTarget,           // existing translation on disk for this locale
        sourceDiff,          // e.g. "removed: [delete]; added: [remove, permanently]"
      }
    },
    ...
  ]
}
```

## Step 1 — Translate ALL locales in ONE reasoning turn

Produce the translation for **every** locale in `group.locales` in a single reasoning turn. No tool call. Output a `{targetLocale: translation}` map. Requirements (apply per locale):

- Follow that locale's `rules` (formality, spelling, antiPatterns, structureRules) and `placementConstraint`.
- Restore every placeholder from `group.placeholders` verbatim and in the same order (translate around them, never translate them).
- Preserve ICU plural/select syntax (`{count, plural, one {…} other {…}}`).
- Preserve HTML/XML tags, escape sequences, and inline formatting.
- Preserve intent and tone, not just words.
- For domain `Legal` or `eDiscovery`: prefer conservative, formal phrasing; do not paraphrase aggressively.

**For MODIFIED groups** (`group.status === "modified"`): if `tm.oldTarget` is non-null, start from `tm.oldTarget` and apply only the edits described by `tm.sourceDiff`. Preserve all phrasing that has not changed in the English source. Only fall back to translating `group.newValue` from scratch if `tm.oldTarget` is null.

**For ADDED groups** (`group.status === "added"`): translate `group.newValue` normally.

Do **not** return to the agent loop between locales. Translate them all in one turn.

## Step 2 — commit_bundle

Call `commit_bundle` **once** per group with one entry per locale:

```
commit_bundle({
  bundleId: group.bundleId,
  updates: [
    {
      targetLocale: L.targetLocale,
      keyPath: group.keyPath,
      value: <translation>,
      needsReview: <true if you have specific quality concerns, false otherwise>,
      failureReason: <short reason string if needsReview is true, null otherwise>,
    },
    ...
  ]
})
```

The server validates placeholder structure and locale rules, computes confidence (`locale×0.727 + structure×0.273`), and overrides `needsReview` to `true` when the confidence tier is `escalate` (≥0.70) or `mandatory` (<0.70). Your `needsReview: true` is also honoured if you have qualitative concerns the scores would not catch.

Then loop back to `next_key_group()`.
