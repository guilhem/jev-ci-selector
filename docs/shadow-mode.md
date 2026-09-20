# Learn from shadow mode

[← Back to the README](../README.md) · [Action reference](reference.md) · [paths-filter migration](paths-filter.md)

Shadow mode answers a practical question: **what would this policy have skipped, and what happened when those tasks actually ran?** All effective outputs remain complete, so you can collect evidence before changing execution. A v4 report separates the policy decision from Jev's observation: the task table describes the policy, while the observation records each actual model response.

The direct output for every task is the exact string `"true"` in shadow mode; the aggregate `run` map contains boolean `true` values. Only the report records the hypothetical proposal. Unless an `always` or `force_paths` rule or a required dependency fixes the decision, the task remains eligible for Jev regardless of which paths changed. Bypassed and fallback plans also keep every task.

## Collect a matched pair

For each run, keep:

1. The JSON file from `report-path`, saved as an artifact from the planning job.
2. Actual results and durations for every catalog task, from the same workflow run and `tested_sha`.

The report path alone does not move the file between jobs. Do not join an old report with the latest PR state or combine separate attempts just because they share a SHA. The analyzer verifies SHA and task IDs; matching the workflow run or attempt is your responsibility.

When Jev is authorized, shadow mode observes every question-bearing task even when deterministic policy rules keep that task in CI. A protected or configured global path can therefore leave the policy status `bypassed` while the v4 observation is complete and contains real per-task scores. Explicit `force-all`, a disabled opt-in, a fork pull request, a missing key, and non-pull-request events remain no-call cases; their observation is `null`.

For a catalog containing `unit` and `helm`, a `results.json` file could look like this. Replace the SHA placeholder with the report's full `tested_sha`:

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

Include **exactly** the task IDs in that run's catalog. Results are `success`, `failure`, `skipped`, or `cancelled`; durations are nonnegative milliseconds. Failure classifications are `regression`, `flaky`, `infrastructure`, or `unknown` (the default). The optional `relevant_tasks` array records suites you manually identified as relevant.

## Compare the proposal with reality

From a checkout of this project, with dependencies installed:

```sh
node scripts/analyze-shadow.mjs report.json results.json
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

Each group reports its paths, byte range, hashes, status, model metadata, usage, and task probabilities. Source text, questions, credentials, and provider error bodies are never written to the report. Cross-chunk interactions are not evaluated globally. A complete observation is required before a hypothetical skip can be considered. For a chunked proposal, the documented heuristic is that a task is proposed to run when any chunk's score is at or above `skip_below`; this is a policy heuristic over per-chunk scores, not a global model probability. The report keeps the task probability `null` in both whole and partitioned cases and the summary does not invent a maximum or aggregate score.

Shadow still keeps every task in the effective plan. `enforce` uses the same grouped judgments and boolean decision rules; it applies the resulting plan.

## Observe a pull request manually

For a workflow dispatch, an operator can request an evaluation for a selected pull request. The action reads pull request metadata with the read-only token, resolves the current immutable base, head, and merge commits, and still validates the merge parents before collecting the diff. The catalog is the trusted file from the workflow's selected `GITHUB_SHA`, so a manual report can intentionally have a `config_sha` different from `base_sha`; record that relationship with the artifact. Manual evaluation supports either mode and publishes its plan without executing CI jobs. Keep the observer workflow in shadow during evaluation.

## From observation to enforce

Compare results by catalog hash, model version, and suite. For v4 reports, inspect policy status and observation status separately, then review every chunk's raw task scores and error code. Look at proposed savings alongside missed regressions and fallback frequency. Classify flaky tests and infrastructure failures separately, and include changes with manually identified relevant suites.

Enable `enforce` only after an explicit review of that evidence. Keep suites that still need observation under `always: true`, and retain full control runs, especially on non-PR events. There is no universal success threshold or guaranteed error rate for the initial `skip_below: 0.05` setting.

To restore full CI immediately, add `force-all: 'true'` to the selector step or switch back to `mode: shadow`. Keep `ci-required` mandatory throughout the rollout.

When all job questions do not fit together, independent questions share the same group state in bounded batches. Each request lists its job IDs and evaluation status; completed answers survive failures in another batch.
