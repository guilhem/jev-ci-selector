# Learn from shadow mode

[← Back to the README](../README.md) · [Action reference](reference.md) · [paths-filter migration](paths-filter.md) · [Independent observer](../examples/shadow/README.md)

Shadow mode answers a practical question: **what would this policy have skipped, and what happened when those tasks actually ran?** All effective outputs remain complete, so you can collect evidence before changing execution. A v4 report separates policy from observation: the task table describes the policy, while the observation records each actual model response.

The direct output for every task is the exact string `"true"` in shadow mode; the aggregate `run` map contains boolean `true` values. Only the report records the hypothetical proposal. Bypassed and fallback plans also keep every task. A non-pull-request invocation makes no Jev call and returns the full effective plan after reading the catalog at `github.sha`.

## Collect a matched pair

For each observation, keep all of the following:

1. The JSON file from `report-path`, saved as the artifact named `jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}` with 14-day retention.
2. The report run ID and attempt.
3. Actual results and durations for every catalog task from the CI run that executed those tasks.
4. The exact `tested_sha`, catalog task IDs, workflow scope, and CI attempt used for that result set.

The integrated examples upload the report with `continue-on-error: true`, so a missing report does not hide a CI result. The report path is local to the planning runner; it does not move between jobs by itself. Do not join an old report with the latest PR state or combine separate attempts just because they share a SHA. The analyzer checks the SHA and task IDs; matching the workflow run, attempt, and task scope is a manual responsibility.

The independent observer is deliberately a different workflow run from the CI run that executes the tasks. Compare the observer report with the CI attempt that tested the same merge commit and catalog scope; do not assume their run IDs or attempts match.

When Jev is authorized, shadow mode observes every question-bearing task even when deterministic policy rules keep that task in CI. A protected or configured global path can therefore leave policy status `bypassed` while the v4 observation is complete and contains real per-task scores. Explicit `force-all`, a disabled opt-in, a fork pull request, a missing key, and non-pull-request events remain no-call cases; their observation is `null`.

## Download an observer report

Use the observer workflow run ID and attempt when downloading its artifact:

```sh
RUN_ID=123456789
RUN_ATTEMPT=1
gh run download "$RUN_ID" \
  --name "jev-plan-report-${RUN_ID}-${RUN_ATTEMPT}" \
  --dir shadow-report
```

The `RUN_ID` here belongs to the standalone observer. The actual task results normally come from another CI run and must be assembled manually.

## Prepare results manually

For a catalog containing `unit` and `helm`, a `results.json` file could look like this. Replace the SHA with the report's full `tested_sha`, and include exactly the task IDs present in that report:

```json
{
  "tested_sha": "<same full SHA as the report>",
  "tasks": {
    "unit": { "result": "success", "duration_ms": 15000 },
    "helm": { "result": "failure", "duration_ms": 8000, "classification": "regression" }
  },
  "relevant_tasks": ["helm"]
}
```

Results are `success`, `failure`, `skipped`, or `cancelled`; durations are nonnegative milliseconds. Failure classifications are `regression`, `flaky`, `infrastructure`, or `unknown` (the default). The optional `relevant_tasks` array records suites you manually identified as relevant. Verify the actual CI attempt and task scope before writing this file. A result from a different catalog, workflow scope, or tested SHA is not a valid pair.

## Compare the proposal with reality

The release bundle is a standalone Node.js 24 program. Copy `dist/analyze-shadow.mjs` and `dist/licenses.txt` from the same action version when using it outside this repository. The source remains available at `scripts/analyze-shadow.mjs`.

```sh
node dist/analyze-shadow.mjs shadow-report/report.json results.json
npm run analyze:shadow -- shadow-report/report.json results.json
```

The analyzer rejects mismatched SHAs, task IDs, or invalid inputs. It returns:

| Field | What it tells you |
| --- | --- |
| `tasks_would_skip` | Tasks the policy proposed excluding |
| `duration_ms_would_skip` | Their summed task durations |
| `failures_would_miss` | Failures among those tasks, grouped by classification |
| `skipped_or_cancelled_would_skip` | Proposed exclusions whose outcomes were not observed |
| `manually_relevant_would_skip` | Manually relevant suites that the policy would exclude |
| `status`, `fallback` | Whether evaluation completed or degraded to full CI |

Task duration is not necessarily elapsed CI time saved: jobs can run in parallel. A skipped or cancelled task is not a successful observation. A passing test is not necessarily an irrelevant test.

## Large diffs and chunked observation

The whole diff is evaluated in one group when it fits; its independent questions may need several bounded requests. Larger diffs use a deterministic `chunked-diff` observation with at most 64 groups, at most three requests in flight, and one global timeout. The default total timeout is 10 seconds; each request is capped at ten seconds and the remaining total budget. A partial response is preserved in the report with completed, failed, and not-started chunks, but full CI remains the effective plan whenever the observation is incomplete or a request fails.

Chunking uses conservative byte guards: at most 64 KiB for the shared state plus the longest question, and at most 128 KiB for each request. These are byte limits, not tokenizer guarantees. The explicit `max-diff-bytes` input is a separate whole-collection cap and remains 64 KiB by default; exceeding it falls back before observation.

Each group reports its paths, byte range, hashes, status, model metadata, usage, and task probabilities. Source text, questions, credentials, and provider error bodies are never written to the report. Cross-chunk interactions are not evaluated globally. A complete observation is required before a hypothetical skip can be considered. For a chunked proposal, the documented heuristic is that a task is proposed to run when any chunk's score is at or above `skip_below`; this is a policy heuristic over per-chunk scores, not a global model probability. The report keeps the task probability `null` in whole and partitioned cases and the summary does not invent a maximum or aggregate score.

Shadow still keeps every task in the effective plan. `enforce` uses the same grouped judgments and boolean decision rules; it applies the resulting plan.

## Observe a pull request manually

For `workflow_dispatch`, an authorized operator can request an evaluation for a selected open pull request. The action reads pull request metadata with the read-only token, resolves the current immutable base, head, and merge commits, and validates merge parents before collecting the diff. The catalog is the trusted file from the selected workflow revision, so a manual report can intentionally have a `config_sha` different from `base_sha`; keep that relationship with the artifact. Manual evaluation supports either mode and publishes its plan without executing CI jobs. Keep the observer in shadow during evaluation.

## From observation to enforce

Compare results by `config_sha`, `catalog_hash`, model version, `tested_sha`, workflow scope, attempt, and suite. For v4 reports, inspect policy status and observation status separately, then review every chunk's raw task scores and error code. Look at proposed savings alongside missed regressions and fallback frequency. Classify flaky tests and infrastructure failures separately, and include changes with manually identified relevant suites.

Enable `enforce` only after an explicit review of that evidence. Keep suites that still need observation under `always: true`, and retain full control runs, especially on non-PR events. There is no universal success threshold or guaranteed error rate for the initial `skip_below: 0.05` setting.

To restore full CI immediately, add `force-all: 'true'` to the selector step or switch back to `mode: shadow`. Keep `ci-required` mandatory throughout the rollout.

When all job questions do not fit together, independent questions share the same group state in bounded batches. Each request lists its job IDs and evaluation status; completed answers survive failures in another batch.
