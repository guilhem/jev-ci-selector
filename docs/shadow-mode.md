# Observe selection with shadow mode

Add `mode: shadow` to any selector step. All effective task outputs remain true; the GitHub job summary shows the proposed exclusions and reasons. You do not need an artifact or another workflow to read the result.

To observe independently from your current CI, use the [observer example](../examples/shadow/README.md). It never controls CI jobs and should not be a required status check.

## Optional report analysis

The examples archive the report for 14 days under a name containing the run and attempt. Upload is soft-failing; it cannot mask a CI failure. Download the artifact for the observation you want:

```sh
RUN_ID=123456789
RUN_ATTEMPT=1
gh run download "$RUN_ID" \
  --name "jev-plan-report-${RUN_ID}-${RUN_ATTEMPT}" \
  --dir shadow-report
```

Prepare actual results manually from the CI run that executed the same tasks:

```json
{
  "tested_sha": "<full SHA matching the report>",
  "tasks": {
    "unit": { "result": "success", "duration_ms": 15000 },
    "build": { "result": "success", "duration_ms": 22000 }
  },
  "relevant_tasks": []
}
```

Use exactly the report's task IDs. The standalone Node.js 24 analyzer accepts report v7:

```sh
node dist/analyze-shadow.mjs shadow-report/report.json results.json
```

Copy the bundle and `dist/licenses.txt` from the same release when using it outside this repository. There is no automatic collector of GitHub job results.

The analyzer checks SHA and task identity. You must independently verify the task scope, commands and CI attempt: the observer and CI have different run IDs, and matching SHAs do not prove matching attempts. Do not combine unrelated retries or changed task definitions.

Inspect proposed skips, missed failures, manually relevant tasks and skipped/cancelled results. The sum of task durations is not necessarily elapsed time saved because jobs overlap, nor does it account for rounded billable minutes.

## Choosing a mode

Selection is applied by default. Explicit shadow mode is useful for evaluating suitability before consuming exclusions. Assess provider failures, flaky tests, infrastructure incidents and tasks known to be relevant. The threshold is a policy setting, not an accuracy guarantee. `force-all: 'true'` returns every task without a Jev request.

## Manual PR observation

A `workflow_dispatch` can pass an open PR number via `pull-request`, with `mode: shadow` and the same inline tasks. Grant `pull-requests: read` as well as `contents: read`. Metadata uses the selected workflow revision; the tested commit belongs to the requested PR. Continue matching results to `tested-sha` rather than the dispatch event SHA. The supplied automatic templates' final gates assume the event SHA and are not manual-PR templates.
