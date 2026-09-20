# Keep your existing CI jobs

[← Back to the README](../../README.md) · [Workflow](.github/workflows/ci.yml) · [Catalog](.github/task-routing.yaml)

Use this integration when your checks are separate jobs with their own setup, or when one task depends on another. The example models a Go and Helm project with `build`, `lint`, `unit`, `helm`, `e2e_network`, and `e2e_upgrade`.

## Install the example

Copy these three files into your repository:

| From this project | Destination in your repository |
| --- | --- |
| [Task routing catalog](.github/task-routing.yaml) | `.github/task-routing.yaml` |
| [Workflow](.github/workflows/ci.yml) | `.github/workflows/ci.yml` |
| [Bundled validator](../../dist/validate.cjs) | `.github/ci-selector-validate.cjs` |

Adapt the commands and tool setup to your project before enabling the workflow. The e2e scripts `./ci/e2e-network.sh` and `./ci/e2e-upgrade.sh` belong to the consuming repository. Install Go, Helm, and any cluster tools through your normal job setup. The validator includes its dependencies and requires Node.js 24; the example installs that runtime in `lint`.

The workflow uses `guilhem/jev-ci-selector@v0.1.0` as the intended release reference. The tag is not assumed to be published until the release; replace it with the full release commit SHA when immutable pinning is required and keep the version in a comment.

Merge the catalog into your base branch before analyzing PRs. Keep `mode: shadow`. Add `JEV_API_KEY` only after approving external context transfer: the example's `allow-external-context: 'true'` sends the diff, changed paths, SHAs, and task questions to TypeSafe. Remove that opt-in to keep every task without a Jev call.

## How it fits together

The single `select` step runs on every event. On `pull_request`, it reads the catalog at the PR base SHA and may observe the diff when authorized. On push, scheduled, and merge-group events, it reads the catalog at `github.sha`, makes no Jev call, and returns a full effective plan. An invalid catalog fails the action. Each consumer checks out `tested-sha`, the merge commit supplied by the PR event or the event SHA for other events.

The network and upgrade jobs declare `needs: [plan, build]`, matching their workflow dependencies. A selected job requires a successful plan and any real prerequisites before running. The planning job never checks out or executes PR code.

Each static job consumes its named plan output, for example `needs.plan.outputs.helm == 'true'`. The plan job publishes every catalog task from `steps.select.outputs.<task>` on every event. The final gate compares those named strings with the aggregate `run` map, so a missing or incorrect mapping cannot silently skip a selected job. The aggregate outputs remain available for the gate and other consumers.

The mandatory `lint` job runs `node .github/ci-selector-validate.cjs .` before linting. Keep that step and `lint.always: true`: they detect catalog/workflow drift, including missing or newly unknown jobs. This validator is the fixed static-template validator; it is not a general validator for arbitrary catalogs. When adding a task, update the catalog, job, dependencies, and final gate together.

Make **`ci-required` a required status check** in your branch rule or ruleset. It checks the plan and every selected job result. Before relying on it, exercise a failing planner and a selected task that fails or is skipped; the final check must fail.

## Validate your changes

In your consumer repository, run the bundled contract validator:

```sh
node .github/ci-selector-validate.cjs .
```

The supplied integrated template also uploads `steps.select.outputs.report-path` as `jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}` with 14-day retention. The upload uses `continue-on-error: true`; it is evidence collection and must not mask CI results.

In this project's checkout, validate the supplied example and its regression cases:

```sh
node examples/validate.mjs examples/static-jobs
npm test
```

The tests check task/job parity, dependencies, malformed plans, skipped selected jobs, and final-gate failures. The validator is mandatory for this supplied template, but an initial independent observation or an arbitrary custom workflow can instead validate the aggregate `run` JSON directly. See [custom workflow gates](../../docs/reference.md#custom-workflow-gates). [Full action reference →](../../docs/reference.md)

For a `paths-filter` migration, keep only narrow must-run cases in `force_paths` (the example uses a chart values schema path). Put the broader behavioral scope in each task's description. See [the migration guide](../../docs/paths-filter.md).
