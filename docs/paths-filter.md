# Migrate from paths-filter

[← Back to the README](../README.md) · [Action reference](reference.md) · [Complete static workflow](../examples/static-jobs/README.md)

Keep the task names and job conditions you already know. Move the decision from “did a file match?” to “does this change affect this task?” The selector's named outputs use the same `true`/`false` string shape as [dorny/paths-filter](https://github.com/dorny/paths-filter#outputs), but they describe tasks to run.

This is a migration for CI job selection. It does not reproduce every `paths-filter` input, glob option, or file-list output. The snippets below are excerpts; use the complete linked workflows for runnable integrations.

## 1. Describe behavior in the catalog

A typical filter step might be:

```yaml
- uses: dorny/paths-filter@v4
  id: changes
  with:
    filters: |
      helm:
        - 'charts/**'
```

Create `.github/task-routing.yaml` in the base branch with a description and job reference for each task:

```yaml
model: jev-1.13.0
skip_below: 0.05
tasks:
  helm:
    description: Covers Helm chart rendering, default values, configuration validation, and generated Kubernetes manifests.
    jobs:
      - workflow: .github/workflows/ci.yml
        job: helm
    force_paths:
      - charts/**/values.schema.json
```

The description defines the scope Jev evaluates, including changes inside `charts/`. Here, `force_paths` deliberately keeps Helm mandatory for values-schema edits. Other chart changes can be proposed for exclusion when their probability falls below the threshold.

Copy an old glob into `force_paths` only if every match must still run that task. A broad `charts/**` force rule preserves every positive path match, so it cannot save additional Helm runs for changes inside that directory. Essential tasks can use `always: true`; execution dependencies stay declared through `needs`.

## 2. Replace the planning step

Keep the selector in a dedicated planning job with `contents: read`, without checking out or executing PR code:

```yaml
- name: Plan CI tasks
  id: select
  uses: guilhem/jev-ci-selector@v0.1.0
  with:
    mode: shadow
    api-key: ${{ secrets.JEV_API_KEY }}
    allow-external-context: 'true'
```

The key and explicit opt-in authorize sending the diff, paths, SHAs, and task questions to TypeSafe, including in shadow mode. Without either, all tasks are kept without a Jev call. Fork pull requests also bypass the API. The active catalog comes from the PR's base SHA; on other events the action reads it at `github.sha`, makes no Jev call, and returns a full effective plan. An invalid catalog fails the action.

## 3. Keep the downstream output names

In the planning job, replace a mapping such as `helm: ${{ steps.changes.outputs.helm }}` with:

```yaml
outputs:
  helm: ${{ steps.select.outputs.helm }}
```

The [static example](../examples/static-jobs/.github/workflows/ci.yml) invokes one `select` step on every event. Its non-PR path is still handled by the action: it reads the catalog at `github.sha`, does not call Jev, and emits `true` for every task in the effective plan.

A consumer condition can keep its existing shape:

```yaml
if: ${{ needs.plan.outputs.helm == 'true' }}
```

Retain real `needs` dependencies and prerequisite success checks. Point consumer checkouts at `needs.plan.outputs.tested-sha`, and add the example's mandatory `ci-required` gate. That gate checks planning success, plan validity, named-output consistency, and the success of every selected job. Do not test the string output directly as a boolean: the string `'false'` is not an empty value.

For an existing matrix built from `paths-filter`'s `changes` array, publish the selector's `selected` array under your existing job output name:

```yaml
outputs:
  packages: ${{ steps.select.outputs.selected }}
```

The consumer can continue to use `fromJSON(needs.plan.outputs.packages)`. Alternatively, use our ready-made `matrix` output. Keep a job-level `has-tasks` guard before matrix expansion, and use only independent tasks. The [matrix example](../examples/matrix/README.md) provides that guard and the final check.

## Know what changes

| Existing usage | Migration |
| --- | --- |
| Named boolean outputs | Same string shape; now means “run this task” |
| `changes` array | Use `selected`, mapping it to your existing job output name if useful |
| Broad component globs | Describe the verification scope and reference the jobs |
| Mandatory path matches | Put deliberate must-run cases in `force_paths` |
| File lists, counts, or advanced filter predicates | No equivalent; retain the file-selection tool for those uses |

Task IDs preserve their spelling, but must be unique ignoring case and cannot collide with standard action output names or reserved catalog IDs. See the [validation rules](reference.md#validation).

Start in `shadow`: **every named task output is `true`**, even when the report proposes skipping it. Bypassed and fallback plans also keep every task; fork PRs never call Jev. The supplied static and matrix templates require their copied, template-specific validator and final gate; an arbitrary custom workflow can validate the aggregate `run` JSON directly and does not need named task outputs. Compare reports with actual outcomes before explicitly switching to `enforce`. [Measure shadow runs →](shadow-mode.md)
