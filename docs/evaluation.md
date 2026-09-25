# Evaluate task selection

The [evaluation corpus](../tests/evaluation/corpus.json) contains eight fictional, self-authored changes with code-inspection relevance annotations. Its [prepared selection](../tests/evaluation/selection.json) supplies four task descriptions. The runtime receives these descriptions and the diff; it does not discover jobs or prepare context files.

From the repository root, run:

```sh
npm run eval:replay
```

Replay needs no API key or network access. It checks that each corpus diff applies to its base files, that every case labels the prepared tasks, and that each Choice question sends only `{description}` as its task payload. Five [explicit mock cases](../tests/evaluation/recordings/mock-choice.json) exercise the selection policy: a task can be skipped only when its choice is `independent` and its coverage is complete. Required, unresolved, absent, or incompletely covered choices retain the task; a protected workflow path retains all tasks. The [corpus guide](../tests/evaluation/README.md) gives the fixture details.

These mocks are contract checks, not Jev responses. No provider campaign was run for the description-only contract, so replay makes no claim about model accuracy, real-project omissions, or CI savings. The incompatible enriched/context recordings were removed; their historical measurements cannot qualify this runtime. A future live evaluation would need new provider evidence collected with the current descriptions and diff grouping. See the [shadow guide](shadow-mode.md) for how proposed selections relate to actual CI execution.
