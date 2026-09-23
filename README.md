# jev-ci-selector

**Run the checks your pull request needs.**

[![Validate action](https://github.com/guilhem/jev-ci-selector/actions/workflows/ci.yml/badge.svg)](https://github.com/guilhem/jev-ci-selector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Describe what your CI jobs verify. **jev-ci-selector** uses [TypeSafe's Jev](https://docs.typesafe.ai/) to assess pull request changes and returns `true` / `false` outputs for your existing jobs. Your workflow keeps its commands, runners and dependencies.

A Helm chart edit and a Go validation fix can need different checks. Give Jev each task's verification scope, keep explicit rules for mandatory checks, and inspect the proposed selection before applying it.

- **Start with one job.** Inline YAML is enough; no extra configuration file or script.
- **Keep control.** Mandatory tasks and path rules take precedence; incomplete evidence keeps the affected checks running.
- **See each decision.** The GitHub job summary shows what runs, what could skip and why, with a JSON report for deeper inspection.

[Quick start](#quick-start) · [Define your tasks](#define-your-tasks) · [How selection works](#how-selection-works) · [Upgrading to v0.3.0](#upgrading-to-v030) · [Reference](docs/reference.md)

> Examples below target **v0.3.0** and require that release tag to be published. See [releases](https://github.com/guilhem/jev-ci-selector/releases) for available versions; pin a released commit SHA when you need an immutable reference.

## Quick start

### 1. Add your API key

Get a key from the [TypeSafe dashboard](https://console.typesafe.ai/) and save it as the repository Actions secret **`JEV_API_KEY`** under **Settings → Secrets and variables → Actions**.

The example sets `allow-external-context: 'true'`: this authorizes sending changed paths, patch text, task descriptions and requested job/file context to the provider. Review the [data and trust boundaries](SECURITY.md) before enabling it. Without both the key and consent, every task stays selected and no Jev request is sent.

### 2. Add the selector and connect a job

For a Go repository, save this as `.github/workflows/ci.yml`, or adapt the two jobs into your existing workflow. For another stack, replace the task description and the `unit` job's setup and test command.

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  selection:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      unit: ${{ steps.select.outputs.unit }}
      tested-sha: ${{ steps.select.outputs.tested-sha }}
    steps:
      - uses: guilhem/jev-ci-selector@v0.3.0
        id: select
        with:
          api-key: ${{ secrets.JEV_API_KEY }}
          allow-external-context: 'true'
          mode: shadow # Observe first: the unit job still runs.
          timeout-ms: '60000' # Optional analysis deadline.
          tasks: |
            unit:
              description: >
                Verifies Go business rules and input validation with unit tests,
                without a database or network access.

  unit:
    needs: selection
    if: ${{ needs.selection.outputs.unit == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ needs.selection.outputs.tested-sha }}
          persist-credentials: false
      - uses: actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5 # v5.5.0
        with:
          go-version-file: go.mod
      - run: go test ./...
```

Three connections make this work:

1. `tasks.unit` describes the check and creates a step output named `unit`.
2. The `selection` job forwards that output; the `unit` job uses it in `if`.
3. The test job checks out `tested-sha`, so it tests the exact commit used for selection. The default is the PR merge commit; use `tested-ref: head` if your CI tests the PR head instead.

Keep the selector job isolated from project checkout, dependency installation and project scripts. With this minimal workflow, require both `selection` and `unit` in branch protection: a skipped test job alone does not prove selection succeeded. If you already have a final CI gate, preserve its failure checks.

### 3. Read the proposed selection

Open the workflow run's **Summary**. In `shadow` mode, every effective task output stays `true`; the **Proposed** column shows which checks selection would keep or skip.

For example, if all changes are judged independent of the Go unit tests, a simplified summary looks like this:

| Task | Effective | Proposed | Reasons |
| --- | --- | --- | --- |
| unit | Run | Skip | `jev-independent`, `shadow-mode` |

**A PR that edits `.github/workflows/` keeps every declared task.** Merge the workflow setup first, then observe ordinary code changes. Push events also keep every task without calling Jev.

### 4. Apply selection when ready

After comparing proposals with actual results on representative PRs, change the selector input:

```yaml
mode: enforce
```

Now a `false` output skips the corresponding job. `enforce` is the action's default; the quick start explicitly uses `shadow` for the observation step. To keep every task and bypass Jev on a run, set `force-all: 'true'`.

Shadow observations help assess your integration; a proposed skip is not a guarantee that a test cannot find a regression. See the [shadow guide](docs/shadow-mode.md) for comparing reports with CI results.

## Define your tasks

A task is a named check with a required `description`. Describe **what it verifies, what it depends on and what is outside its scope**. Keep the description about the job itself, so it remains useful across PRs.

| Too vague | Useful verification scope |
| --- | --- |
| Run integration tests. | Verifies HTTP authentication and PostgreSQL persistence using a migrated test database; does not exercise browser rendering. |
| Check Helm. | Verifies Helm chart rendering, values validation and Kubernetes resource templates; does not execute application code. |

For an existing integration job, add its workflow reference and relevant setup files to give Jev more context:

```yaml
tasks: |
  integration:
    description: >
      Verifies HTTP authentication and PostgreSQL persistence using a migrated
      test database; does not exercise browser rendering.
    jobs:
      - workflow: .github/workflows/ci.yml
        job: integration
    context_files:
      - tests/integration/setup.ts
    force_paths:
      - migrations/**
  lint:
    description: Verifies TypeScript ESLint rules.
    always: true
```

Adapt the job and file paths to your repository. For each added task, forward its output and wire the matching job's `if`, as in the quick start.

| Field | When to use it |
| --- | --- |
| `description` | Always. A precise description is enough to define a task. |
| `jobs` | Provide workflow/job commands, action inputs and related metadata as evidence. |
| `context_files` | Include known configuration, setup or helper files that explain the check. |
| `force_paths` | Always select this task when a positive glob matches. No match still leaves the task open to analysis. |
| `always: true` | Keep a task mandatory, such as a prerequisite build or a check you want on every run. |
| `resolve_context_files: true` | Opt into experimental discovery of additional relevant files. Defaults to `false`; explicit context files remain available either way. |

For automatic PR analysis, job and file metadata are read from the PR base commit without executing repository code. Referenced jobs and files must exist there. Discovery considers tracked repository paths and adds API work; explicit `context_files` are the more predictable option for large repositories.

**Dependencies stay in your workflow.** If E2E needs a build, keep `needs: [selection, build]` and make the build mandatory with `always: true`. Task descriptions and `jobs` references do not schedule prerequisites.

Need help describing a large workflow? The included [describe-ci-jobs skill](skills/describe-ci-jobs/SKILL.md) follows commands, configuration and local actions to derive task descriptions and explicit context.

## How selection works

1. **Apply your rules.** `always`, matching `force_paths` and workflow changes keep tasks selected.
2. **Identify checks that already need to run.** In `enforce`, a preliminary assessment of changed paths can retain a task, but cannot skip one.
3. **Read changes progressively.** Jev evaluates change groups against the remaining tasks. In `enforce`, analysis of a task stops once it must run.
4. **Skip only with complete evidence.** Every inventoried change must be covered and every group judged `independent` for that task.

| Jev's judgment for a change group | Effect on the task |
| --- | --- |
| `required` | Keep it. |
| `unresolved` | Keep it. |
| `independent` | Permit skipping only if every group is independent and coverage is complete. |

There is no confidence threshold to tune. Raw choices, distributions and confidence remain available in the report for inspection.

| Situation | Behavior |
| --- | --- |
| Fork PR, missing key or consent, or `force-all: 'true'` | Keep every task; no Jev call. |
| Push, schedule or merge-group event | Keep every task; automatic selection runs on PRs. Manual PR analysis is also [supported](docs/reference.md#events-provenance-and-selection). |
| Provider failure, unreadable context or an exhausted analysis limit | Keep affected tasks. Tasks with complete independent decisions may still skip; a global fallback keeps all tasks. |
| Invalid task definitions or unexpected internal errors | Fail the selector job; no usable plan is published. |

## Read the outputs

Outputs are strings. Compare named task outputs with **`'true'`** explicitly; use `fromJSON` for aggregate JSON values.

| Output | Example or purpose |
| --- | --- |
| `<task-id>` | `'true'` or `'false'`, ready for a job's `if`. |
| `run` | `{"unit":true,"helm":false}` — all effective task decisions. |
| `selected` | `["unit"]` — selected task IDs. |
| `matrix` | `{"include":[{"task":"unit"}]}` — independent task matrix. |
| `has-tasks` | `'true'` or `'false'`; check before expanding a matrix. |
| `tested-sha` | Immutable commit consumers must check out. |
| `status` | `planned`, `bypassed` or `fallback`. |
| `report-path` | Runner-local path to the JSON report, ready for optional artifact upload. |

`planned` means a selection was produced; `bypassed` means every task was retained by a bypass rule; `fallback` means missing or unusable evidence kept some or all tasks. Inspect task reasons and `analysis.fallback_scope` for the details.

The report includes proposed and effective decisions, coverage, API usage, byte counts and timings. It omits source bodies, diffs and secrets, but still contains repository metadata. The job summary is written automatically; artifact upload and the standalone analyzer are [optional](docs/shadow-mode.md).

## Control analysis time and cost

All four limits default to **`0`**, meaning no action-level ceiling. Requests adapt to the provider's window and rate limits; the GitHub job timeout still applies.

| Input | What it limits |
| --- | --- |
| `timeout-ms` | Shared context-preparation and analysis time, starting after the change inventory is built. |
| `max-collected-patch-bytes` | Patch bytes actually received from Git, including rejected or retried reads. |
| `max-analysis-bytes` | Complete request JSON bytes sent to the API. |
| `max-jev-calls` | Dispatched API calls, including failed calls. |

The quick start sets `timeout-ms: '60000'` so an expired analysis budget can retain affected tasks and publish a fallback report. A job killed by GitHub's `timeout-minutes` publishes no selection outputs or report. Set an internal deadline if you need that graceful fallback.

In `enforce`, a run whose tasks are all mandatory reads no patches and makes no Jev calls. `shadow` continues observing tasks to collect evidence, so it can do more analysis. Compare selector usage with your own CI timings when assessing savings.

For preparation budget sharing and custom Jev-compatible providers, see the [input reference](docs/reference.md#inputs) and [provider contract](docs/reference.md#provider-contract).

## Upgrading to v0.3.0

This release introduces progressive change analysis, earlier decisions for required tasks and per-task coverage. Incomplete evidence is scoped to the affected tasks, so a partial fallback can preserve another task's completed skip decision.

Before changing an existing integration's action reference:

1. **Replace `max-diff-bytes`, if configured.** It has been removed and now causes an input error. `max-collected-patch-bytes` limits bytes actually collected, including retries, rather than the size of a complete diff.
2. **Review your limits.** All four ceilings now default to `0`. Set explicit values if your integration needs a time, byte or call budget.
3. **Update report consumers to v8.** Use `manifest.hash` for the change inventory; `diff_hash` and `diff_bytes` remain `null` in normal progressive runs. Use the matching analyzer version and allow partial fallback decisions in custom gates.
4. **Recheck proposals in `shadow`.** Exercise representative PRs, including changes that span several groups, before enabling selection in your repository.

See the [changelog](CHANGELOG.md) for release details and validation limits. Recorded evaluation replays validate the saved request contract; they do not establish production accuracy or CI savings for the new progressive analysis.

## More examples and documentation

| You want to… | Start here |
| --- | --- |
| Wire several existing jobs and preserve prerequisites | [Static jobs and a final CI gate](examples/static-jobs/README.md) |
| Run independent checks through a matrix | [Task matrix](examples/matrix/README.md) |
| Observe proposals alongside existing CI | [Standalone shadow observer](examples/shadow/README.md) |
| Move from path filters | [Migration from paths-filter](docs/paths-filter.md) |
| Look up every input, task field and output | [Action reference](docs/reference.md) |
| Validate task definitions or reports | [Task schema](schemas/tasks.schema.json) · [Report schema](schemas/report.schema.json) |
| Review data handling | [Security](SECURITY.md) |

## Development

The action uses the Node.js 24 runtime. Use a GitHub-hosted runner or a self-hosted runner with Node.js 24 action support. For local development, use Node.js 24 and Git:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm run eval:replay
```

Tests use temporary Git repositories, mocked HTTP and the shipped bundles. Replay checks committed evaluation recordings without a key or network; see [evaluation details](docs/evaluation.md).

Commit regenerated bundles with their sources. `npm run check:dist` checks reproducibility. The action and standalone analyzer include their dependency license notices.

Released under the [MIT license](LICENSE).
