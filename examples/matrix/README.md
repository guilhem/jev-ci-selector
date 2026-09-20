# Run independent tasks in a matrix

[← Back to the README](../../README.md) · [Workflow](.github/workflows/ci.yml) · [Catalog](.github/task-routing.yaml)

Use this integration when every task can run independently through the same launch mechanism. If jobs need ordered dependencies, start with the [static jobs example](../static-jobs/README.md).

## Install the example

Copy these three files into your repository:

| From this project | Destination in your repository |
| --- | --- |
| [Task routing catalog](.github/task-routing.yaml) | `.github/task-routing.yaml` |
| [Workflow](.github/workflows/ci.yml) | `.github/workflows/ci.yml` |
| [Bundled validator](../../dist/validate.cjs) | `.github/ci-selector-validate.cjs` |

The example uses Go, Helm, and the consumer-owned scripts `./ci/e2e-network.sh` and `./ci/e2e-upgrade.sh`. Adapt their commands and tool setup. Each matrix task must prepare and build its own prerequisites: the `build` entry does not supply artifacts or ordering to the e2e entries.

The workflow uses `guilhem/jev-ci-selector@v0.1.0` as the intended release reference. The tag is not assumed to be published until the release; replace it with the full release commit SHA when immutable pinning is required and keep the version in a comment. The standalone validator needs no npm installation; the `ci-contract` job installs Node.js 24.

Merge the catalog into the base branch before analyzing PRs, and keep `mode: shadow`. The example's `allow-external-context: 'true'` authorizes sending the diff, changed paths, SHAs, and task questions to TypeSafe when `JEV_API_KEY` is configured. Remove the opt-in if that transfer is not approved.

## How it fits together

The single `select` step runs on every event. On `pull_request`, it reads the catalog at the PR base SHA and may observe the diff when authorized. On push, scheduled, and merge-group events, it reads the catalog at `github.sha`, makes no Jev call, and returns a full effective plan. An invalid catalog fails the action. Consumers check out the plan's `tested-sha`.

The matrix launcher uses the aggregate `matrix` output. Named action outputs remain available for consumers with separate jobs; the [static example](../static-jobs/README.md) shows how to forward them.

The mandatory `ci-contract` job checks the catalog and workflow at that SHA, including when the selected matrix is empty. The matrix and final gate both require its success. Keep validation outside the planning job.

The launcher uses a fixed task allowlist and rejects unsupported IDs. Keep it, the catalog, and the final gate in sync. Workflow `needs` remains the owner of prerequisites; matrix entries cannot order or satisfy one another.

The `has-tasks` condition runs at job level before matrix expansion. A valid empty selection skips the matrix and can pass `ci-required`, provided planning and contract validation succeeded. Selected matrix failures remain failures; there is no `continue-on-error` or internal condition that skips the selected command.

The supplied integrated template also uploads `steps.select.outputs.report-path` as `jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}` with 14-day retention. The upload uses `continue-on-error: true`; it is evidence collection and must not mask CI results.

Make **`ci-required` a required status check** in your branch rule or ruleset. Exercise a failing planner, a failed or skipped selected matrix, and an empty selection before relying on the integration.

## Validate your changes

In your consumer repository:

```sh
node .github/ci-selector-validate.cjs .
```

In this project's checkout:

```sh
node examples/validate.mjs examples/matrix
npm test
```

The tests check catalog/launcher consistency and run the final gate against invalid plans, skipped matrices, empty selections, and matrix failures. The validator is mandatory for this supplied template, but an initial independent observation or an arbitrary custom workflow can instead validate the aggregate `run` JSON directly. See [custom workflow gates](../../docs/reference.md#custom-workflow-gates). [Full action reference →](../../docs/reference.md)

For a `paths-filter` migration, keep only narrow must-run cases in `force_paths` (the example uses a chart values schema path). Put the broader behavioral scope in each task's description. See [the migration guide](../../docs/paths-filter.md).
