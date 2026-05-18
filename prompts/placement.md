# Placement Constraints

Each task carries a `placement` derived from the key path. Always call `get_locale_rules` with this placement so the response includes the constraint string. Then enforce it during step 5 (translate).

- `button_or_menu_item` — ≤3 words, action-led verb-first, no terminal punctuation, sentence case.
- `label_placeholder_title` — ≤6 words, noun phrase, no terminal punctuation.
- `error_message` — exactly one complete sentence with terminal punctuation; state what failed and (if possible) how to recover.
- `tooltip` — one to two short sentences; plain language, no marketing.
- `notification` — one concise sentence; present tense; user-centric.
- `legal_disclaimer` — formal legal register; conservative phrasing; preserve exact legal terms.
- `unspecified` — no length cap; default product-UI register.

If a constraint conflicts with the source's literal length (e.g. source is a long button label), translate as best-effort and use the review path.
