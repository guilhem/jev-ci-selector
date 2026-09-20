# Synthetic corpus qualification — 2026-09-20

All eight scenarios, their diffs, source snapshots and action descriptors were
authored from scratch for this public repository. They are fictional examples,
not extracts, renamed copies or adaptations of an existing application. The
base/head hashes identify locally generated fixture commits. Relevance labels
were fixed by code inspection before the API calls; they are not independently
human-validated ground truth.

The new campaign contains 96 calibration runs and 24 validation runs, all using
`jev-1.13.0`. Calibration selected **enriched context, one question, threshold
0.10**: no relevant omissions among 42 relevant decisions and 54/54 correct
irrelevant omissions. Selection maximizes useful omissions without relevant
misses, then uses the lowest threshold. The complete variant/threshold comparison
is recorded in `recordings/calibration/summary.json`.

With that choice frozen, the four reserved validation cases produced:

- No relevant omission among 18 relevant decisions.
- 73/78 correct irrelevant omissions (93.6%); five unnecessary retentions.
- One case/task/grouping disagreement across the three repetitions.
- One case/task/repeat disagreement between grouping variants.
- 33 API calls, 157,881 input tokens and 2,244 output tokens; mean run 393 ms.

Calibration used 96 API calls, 301,128 input tokens and 10,368 output tokens;
mean run 336 ms. Counts include repeated decisions, not independent changes.
No responses were replaced by expected labels, and all mistakes remain recorded.

Seven small diffs fit in one actual group under both budgets. The larger theme
change uses one natural group versus four partitioned groups, repeated three
times. Thus only that case measures a real partitioning difference; identical
single-group runs do not establish broader partition invariance.

This demonstrates useful selection on simple synthetic scenarios. It does not
measure accuracy on a real application's changes or CI runtime savings. The
winning settings belong to this corpus and are not automatically promoted into
configuration or a consuming CI. Effective shadow outputs retain every task.

Run `npm run eval:replay` without a key or network. A new `eval:live` campaign
compares against these baselines without replacing them. These are the first
campaigns for this corpus, so their comparison files explicitly have no baseline;
measurements from different inputs cannot serve as their comparison reference.
