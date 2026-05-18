# Loop Contract

Run this loop until the queue is empty:

```
while true:
  resp = next_task()
  if resp.task is null: break
  task = resp.task

  # 8-step pipeline (described below). Run them in order.
  # Each step's traceToken must be passed to validate_translation.
  ...

  commit_bundle({ bundleId: task.bundleId, updates: [{ ... }] })
  # then loop back to next_task()
emit_report({ stats: <your tally> })
STOP
```

Rules:

- Process one task per loop iteration. Do not batch multiple tasks before committing.
- Each task is fully self-contained: do not let knowledge from a prior task's text "leak" into a different translation.
- After `next_task()` returns null, call `emit_report` exactly once, then stop.
- Never skip the pipeline. `validate_translation` requires the chain of traceTokens from `normalize_text`, `search_glossary`, `classify_domain`, and `get_locale_rules`. Skipping any of those returns `MISSING_TRACE_TOKEN` and forces self-correction.
