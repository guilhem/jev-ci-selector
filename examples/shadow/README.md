# Observe a pull request independently

[← Back to the README](../../README.md) · [Observer workflow](.github/workflows/observe.yml) · [Catalog](.github/task-routing.yaml) · [Shadow guide](../../docs/shadow-mode.md)

Use this example to measure proposals before changing an existing CI workflow. It is an independent observer: it creates a report artifact, never controls another job, and is not a required status check.

## Install the observer

Copy these two files into the consuming repository, then adapt the catalog's job references and descriptions to the jobs already defined by `.github/workflows/ci.yml`:

| From this project | Destination in your repository |
| --- | --- |
| [Observer workflow](.github/workflows/observe.yml) | `.github/workflows/observe.yml` |
| [Task routing catalog](.github/task-routing.yaml) | `.github/task-routing.yaml` |

The supplied catalog contains `unit` and `build` references to `.github/workflows/ci.yml` as a small example. Replace those references, task IDs, and descriptions with the actual jobs and verification scope in your repository. Merge the catalog into the base branch before opening or observing the pull request. Automatic pull requests read the trusted catalog at the event's base SHA.

The workflow triggers on `pull_request` and requests only `contents: read`. Its planning job does not check out the repository, install dependencies, execute project code, or wire action outputs into CI jobs. It is an optional observer and must not be configured as a required check. The observer and the CI run that executes the tasks are separate workflow runs.

## Reference and authorization

The example uses:

```yaml
uses: guilhem/jev-ci-selector@v0.1.0
with:
  mode: shadow
  tested-ref: merge
  api-key: ${{ secrets.JEV_API_KEY }}
  allow-external-context: 'true'
```

`v0.1.0` is the intended release reference, not a claim that the tag is already published or remotely tested. Replace it with the full commit SHA for that release when immutable pinning is required, and keep the version in a comment. `tested-ref: merge` is the default and should match CI that tests the pull request merge commit. Use `head` only when the existing CI deliberately tests the pull request head.

An authorized shadow call sends the diff, changed paths, commit SHAs, trusted task metadata, and questions to the configured provider. Fork pull requests, a missing `JEV_API_KEY`, or missing `allow-external-context: 'true'` bypass the API and keep every task. The observer has no API jobs collector and does not execute project code.

The report upload uses the selector's `report-path`, the artifact name `jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}`, and 14-day retention. The upload is soft-failing with `continue-on-error: true`; failure to save evidence must not change the observer result. No validator is required for this initial observation workflow.

## Match it with CI

Download the observer artifact with its run ID and attempt. The attempt is part of the artifact name:

```sh
RUN_ID=123456789
RUN_ATTEMPT=1
gh run download "$RUN_ID" \
  --name "jev-plan-report-${RUN_ID}-${RUN_ATTEMPT}" \
  --dir shadow-report
```

Create `results.json` manually from the separate CI run that actually executed the catalog tasks:

```json
{
  "tested_sha": "<same full SHA as shadow-report/report.json>",
  "tasks": {
    "unit": { "result": "success", "duration_ms": 15000 },
    "build": { "result": "success", "duration_ms": 22000 }
  },
  "relevant_tasks": []
}
```

Use exactly the same `tested_sha` and task IDs as the v4 report. Verify manually that the CI attempt and task scope match the report's catalog and workflow. The standalone observer run is different from the CI run, so their run IDs and attempts normally differ. A result from another commit, catalog, workflow scope, or attempt is not a valid measurement pair.

## Analyze the pair

The release bundle includes a standalone Node.js 24 analyzer. Copy `dist/analyze-shadow.mjs` and `dist/licenses.txt` from the same version as the action when using it outside this repository. The source is `scripts/analyze-shadow.mjs`.

```sh
node dist/analyze-shadow.mjs shadow-report/report.json results.json
npm run analyze:shadow -- shadow-report/report.json results.json
```

The analyzer rejects mismatched SHAs, task IDs, and invalid results. Review `tasks_would_skip`, `duration_ms_would_skip`, `failures_would_miss`, `skipped_or_cancelled_would_skip`, and `manually_relevant_would_skip` before considering `enforce`. CI duration saved is not necessarily wall-clock time saved because jobs can run in parallel. Keep the integrated workflow's `ci-required` gate mandatory if you later adopt selective execution.
