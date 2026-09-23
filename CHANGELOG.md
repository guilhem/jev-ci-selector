# Changelog

All notable changes to this project are documented here.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking.** The action no longer builds a complete diff before deciding.
  It inventories the change set from `diff --raw`, applies the deterministic
  rules first, and then collects patch text one bounded unit at a time, only
  while a task is still undecided. A selection whose tasks are all already
  required reads no patch and dispatches no API call in `enforce`.
- **Breaking.** `max-diff-bytes` is removed. It bounded the size of a complete
  diff, which is no longer built, so it is not reinterpreted: supplying it now
  fails with a migration diagnostic. Use `max-collected-patch-bytes`, which
  bounds the patch text actually collected.
- **Breaking.** Report version 8. `diff_hash` and `diff_bytes` stay `null`
  unless a complete diff was built; the inventory is identified by
  `manifest.hash`, and observation groups carry `change_ids` and `unit_index`
  instead of offsets into a global diff.
- A task retained because its job metadata could not be read now reports
  `fallback` like one retained for an incomplete context. Both are degraded
  outcomes; reporting one as `planned` announced a fallback scope of `none`
  while a task was in fact being kept. Effective outputs are unchanged.
- A missing decision no longer forces every output to `true`. Missing evidence
  is scoped to the tasks it concerns, so a task with a complete decision keeps
  it while the root status reports `fallback`.

### Added

- Context preparation states its question wording once in the state instead of
  repeating it in every per-path question. Measured live on the labelled
  corpus: recall 4/7/7 against 3/6/7 over one, two and three passes, no
  incorrect skips either way, 11% fewer input tokens, and roughly half the
  calls and bytes at 20 000 tracked files.
- A coarse pass asks one question per task over the manifest's paths, statuses
  and modes before any patch is read. Its question has two options, `required`
  and `undetermined`: with no `independent` option a wrong exclusion cannot be
  expressed. It never grants coverage, and a failed coarse call retains
  nothing. Measured live it settled 2 of 2 conclusive path cases and wrongly
  forced none, and abstained entirely on a corpus of indirect links. Costs one
  call per run; saves the whole content sweep for every task it settles.
- Nothing needs sizing for scale. Every ceiling defaults to `0`, meaning none:
  a run is bounded by the provider's window and rate limits and by the job's
  own `timeout-minutes`. Measured with one task over changes judged
  independent: 200 files in 9 calls, 1 000 in 51, 5 000 in 256, 20 000 in
  1 025 — all `planned` with a real skip, where 200 files previously fell back.
  The ceilings remain available for anyone who wants one.
- Requests are sized from the provider's documented window using a
  bytes-per-token ratio measured from `usage.input_tokens`, and a payload the
  provider refuses is split and retried instead of abandoned. Concurrency
  adapts between one and eight, shared by preparation and analysis, halving on
  a rate limit. Rate limits and transient faults are retried with backoff,
  bounded by the deadline.
- `max-collected-patch-bytes`, `max-analysis-bytes` and `max-jev-calls` inputs.
  All three now default to `0` (no ceiling).
  Each counts what it names — real UTF-8 or JSON bytes, and dispatched calls —
  and never estimates provider tokens.
- A shared budget with reservation before dispatch, so concurrent requests
  cannot collectively exceed a ceiling, and an internal preparation sub-limit
  so context preparation cannot starve the decision it serves.
- A per-task coverage registry. An exclusion requires every inventoried change
  to have been read and judged independent for that task; an unread change is
  never independent by default.
- Report counters for what was measured and what was never read:
  `manifest`, `analysis.*`, per-task states and coverage, and the scope of any
  fallback. `analysis.patch_bytes_read` counts every byte Git produced,
  rejected and retried attempts included; `analysis.patch_bytes_delivered`
  counts only the patch text handed to the analysis. `analysis.changes_read`
  against `analysis.changes_total` says how much of the inventory was reached.

### Notes

- `timeout-ms` keeps its historical meaning and its clock starts once the
  inventory is built, so a slow fetch cannot consume the analysis allowance.
  Git commands keep their own separate timeouts. It now defaults to `0`, no
  internal deadline: a step killed by the job's own timeout publishes no report
  and no outputs, so set it if a graceful fallback matters more.
- Context discovery still costs one question per tracked repository path, so it
  remains the limiting factor for very large repositories; `context_files`
  stays the predictable option there.
- `npm run eval:replay` exercises the whole-diff path, so it qualifies the
  recorded request contract, not the progressive collection path. A campaign
  over multi-unit and cross-boundary cases is still owed before promoting the
  new grouping to `enforce` on real repositories.
- Rename detection is off in the inventory, so a rename appears as a deletion
  plus an addition. Both paths therefore stay visible to `force_paths` and the
  protected-path rule.
- The budgets' starting values are defaults to qualify against a corpus, not
  guaranteed performance figures.

## [0.1.0] - 2026-09-21

### Added

- Inline `tasks` definitions with descriptions, job metadata, context files,
  mandatory tasks and positive `force_paths` rules.
- Deterministic task selection with conservative fallback behavior and optional
  Jev evaluation.
- Named task outputs plus aggregate `run`, `selected`, `matrix`, `has-tasks`,
  `status`, `tested-sha` and `report-path` outputs.
- Validated, source-free report version 5 with provenance, decision and
  observation details.
- Explicit shadow mode for observing proposed exclusions while retaining every
  effective CI task.

### Notes

- The default `skip-below` threshold is experimental and is a policy setting,
  not an accuracy guarantee.
- The action requires Node.js 24 support from the GitHub Actions runner.
