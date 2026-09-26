# jev-ci-selector

**Run the checks your change needs.**

[![Validate action](https://github.com/guilhem/jev-ci-selector/actions/workflows/ci.yml/badge.svg)](https://github.com/guilhem/jev-ci-selector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Describe what your CI jobs verify. **jev-ci-selector** sends those descriptions and the PR or push diff to [TypeSafe's Jev](https://docs.typesafe.ai/) and returns `true` / `false` outputs for your existing jobs. Your workflow owns commands, runners, dependencies and any decision to run everything.

A Helm chart edit and a Go validation fix can need different checks. Give Jev each task's verification scope, keep explicit rules for mandatory checks, and inspect the proposed selection before applying it.

- **Prepare descriptions once.** Use the included skill while authoring your workflow, then paste its descriptions into inline YAML.
- **Keep control.** Put mandatory checks and branch or path rules in your workflow; incomplete evidence keeps the affected checks running.
- **See each decision.** The GitHub job summary shows what runs, what could skip and why, with a JSON report for deeper inspection.

[Quick start](#quick-start) · [Define your tasks](#define-your-tasks) · [How selection works](#how-selection-works) · [Migration](#migrating-to-workflow-owned-execution-rules) · [Reference](docs/reference.md)

> The workflows below use `@main` as a non-tagged example reference. Use them after this change reaches `main`; `@main` moves, so pin the resulting commit SHA for reproducible CI. No release tag for this breaking contract is assumed to exist.

## Quick start

### 1. Add your API key

Get a key from the [TypeSafe dashboard](https://console.typesafe.ai/) and save it as the repository Actions secret **`JEV_API_KEY`** under **Settings → Secrets and variables → Actions**.

The example sets `allow-external-context: 'true'`: this authorizes sending changed paths, patch text and task descriptions to the provider. Review the [data and trust boundaries](SECURITY.md) before enabling it. Without both the key and consent, every task stays selected and no Jev request is sent.

### 2. Describe the job before editing CI

From a checkout of this repository, install the included [describe-ci-jobs skill](skills/describe-ci-jobs/SKILL.md) into Codex's personal skills directory, then invoke it while preparing the workflow:

```sh
mkdir -p ~/.codex/skills
cp -R skills/describe-ci-jobs ~/.codex/skills/
```

```text
$describe-ci-jobs Inspect .github/workflows/ci.yml and the commands it runs.
Write the verification scope for the unit job as an inline jev-ci-selector task.
Keep its task ID and verification scope; execution rules belong in the workflow.
```

If you use another coding agent, ask it to read `skills/describe-ci-jobs/SKILL.md` from the checkout and perform the same inspection.

Review the result against the actual commands, scripts, configuration and tests. Paste the `description` into `tasks.unit` below and refresh it when the job's scope changes. The skill runs during authoring; GitHub Actions runs only the selector action, which sends the saved description with the diff to Jev. The Go description below is an example for a repository where `go test ./...` checks business rules and input validation; replace it with evidence from your own job.

### 3. Add the selector and connect a job

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
    if: ${{ github.ref != 'refs/heads/main' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      unit: ${{ steps.select.outputs.unit }}
      tested-sha: ${{ steps.select.outputs.tested-sha }}
    steps:
      - uses: guilhem/jev-ci-selector@main
        id: select
        with:
          api-key: ${{ secrets.JEV_API_KEY }}
          allow-external-context: 'true'
          timeout-ms: '60000' # Optional analysis deadline.
          tasks: |
            unit:
              description: >
                Runs go test ./... over Go package tests for business rules and
                input validation. Go source and dependencies used by those tests
                are inputs; this job does not run browser tests.

  unit:
    needs: selection
    if: ${{ !cancelled() && (github.ref == 'refs/heads/main' || (needs.selection.result == 'success' && needs.selection.outputs.unit == 'true')) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.ref == 'refs/heads/main' && github.sha || needs.selection.outputs.tested-sha }}
          persist-credentials: false
      - uses: actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5 # v5.5.0
        with:
          go-version-file: go.mod
      - run: go test ./...
```

Three connections make this work:

1. `tasks.unit` describes the check and creates a step output named `unit`.
2. The `selection` job forwards that output; the `unit` job uses it in `if`. On `main`, this workflow skips the selector and runs the unit job directly.
3. The test job checks out `tested-sha`, or the event SHA when the caller bypasses selection on `main`. The default PR comparison uses the merge commit; use `tested-ref: head` if your CI tests the PR head instead.

`!cancelled()` overrides GitHub's implicit success condition, so a skipped `selection` dependency does not skip the main-branch job. The explicit `needs.selection.result == 'success'` still blocks a failed selector on PRs. See GitHub's [job dependency rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds). This main-branch policy belongs entirely to this workflow. If you call the action on a push, it analyses the complete `before` → `after` range instead.

Keep the selector job isolated from project checkout, dependency installation and project scripts. With this minimal workflow, require both `selection` and `unit` in branch protection: a skipped test job alone does not prove selection succeeded. If you already have a final CI gate, preserve its failure checks.

### 4. Read the proposed selection

Open the workflow run's **Summary** to see the selected tasks and reasons. To observe first while your CI continues running every job, use the [independent observer](examples/shadow/README.md) without wiring its outputs into CI conditions.

For example, if all changes are judged independent of the Go unit tests, a simplified summary looks like this:

| Task | Effective | Proposed | Reasons |
| --- | --- | --- | --- |
| unit | Skip | Skip | `jev-independent` |

Workflow files are analysed like other changed paths. The action has no branch, event or path policy that voluntarily runs everything. To require checks on every run, give those jobs unconditional workflow conditions and keep prerequisites in `needs`.

Observation alongside full CI helps assess your integration; a proposed skip is not a guarantee that a test cannot find a regression. See the [observation guide](docs/shadow-mode.md) for comparing reports with CI results.

## Define your tasks

A task is a named check with a required `description`. Describe **what it verifies, what it consumes and what is outside its scope**. Keep the description about the job itself, so it remains useful across PRs. The skill reads the job and its local scripts before you save the description; the selector does not discover job or file context during CI.

| Too vague | Useful verification scope |
| --- | --- |
| Run integration tests. | Verifies HTTP authentication and PostgreSQL persistence using a migrated test database; does not exercise browser rendering. |
| Check Helm. | Verifies Helm chart rendering, values validation and Kubernetes resource templates; does not execute application code. |

For an integration job, put the relevant scope into the description itself:

```yaml
tasks: |
  integration:
    description: >
      Verifies HTTP authentication and PostgreSQL persistence using a migrated
      test database. The API routes, authentication rules, migrations and test
      setup are inputs; it does not exercise browser rendering.
  lint:
    description: Verifies TypeScript ESLint rules.
```

Adapt the scope to inspected commands and files in your repository. For each added task, forward its output and wire the matching job's `if`, as in the quick start.

| Field | When to use it |
| --- | --- |
| `description` | Always. A precise description is enough to define a task. |

`jobs`, `context_files` and `resolve_context_files` are rejected. Migrate their useful evidence into each `description` before running CI.

**Dependencies stay in your workflow.** If E2E needs a build, keep `needs: [selection, build]` and run the build regardless of its selection output in the caller workflow. Task descriptions do not schedule prerequisites.

Need help describing a large workflow? The included [describe-ci-jobs skill](skills/describe-ci-jobs/SKILL.md) follows commands, configuration and local actions to derive the descriptions you save inline.

## How selection works

1. **Verify the comparison.** PRs use their verified head or merge commit; pushes compare the exact before and after commits.
2. **Identify checks that already need to run.** A preliminary assessment of changed paths can retain a task, but cannot skip one.
3. **Read changes progressively.** Jev evaluates change groups against the remaining tasks. Analysis of a task stops once it must run.
4. **Skip only with complete evidence.** Every inventoried change must be covered and every group judged `independent` for that task.

| Jev's judgment for a change group | Effect on the task |
| --- | --- |
| `required` | Keep it. |
| `unresolved` | Keep it. |
| `independent` | Permit skipping only if every group is independent and coverage is complete. |

There is no confidence threshold to tune. Raw choices, distributions and confidence remain available in the report for inspection.

| Situation | Behavior |
| --- | --- |
| Fork PR, missing key or consent | Keep every task; no Jev call. |
| PR or valid push | Analyse all declared tasks. Pushes include every commit in the before/after range, even after history is rewritten. |
| Missing/zero/unavailable push refs, or an event without a usable comparison | Keep every task through the reference safety fallback. [Manual PR analysis](docs/reference.md#events-provenance-and-selection) remains supported. |
| Provider failure, unreadable diff or an exhausted analysis limit | Keep affected tasks. Tasks with complete independent decisions may still skip; a global fallback keeps all tasks. |
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

`planned` means a selection was produced; `bypassed` means every task was retained because a safety prerequisite was missing; `fallback` means missing or unusable evidence kept some or all tasks. Inspect task reasons and `analysis.fallback_scope` for the details.

The report includes proposed and effective decisions, coverage, API usage, byte counts and timings. It omits source bodies, diffs and secrets, but still contains repository metadata. The job summary is written automatically; artifact upload and the standalone analyzer are [optional](docs/shadow-mode.md).

## Control analysis time and cost

All four limits default to **`0`**, meaning no action-level ceiling. Requests adapt to the provider's window and rate limits; the GitHub job timeout still applies.

| Input | What it limits |
| --- | --- |
| `timeout-ms` | Analysis time, starting after comparison and change inventory. |
| `max-collected-patch-bytes` | Patch bytes actually received from Git, including rejected or retried reads. |
| `max-analysis-bytes` | Complete analysis request JSON bytes sent to the API. |
| `max-jev-calls` | All dispatched analysis API calls, including failed calls. |

The quick start sets `timeout-ms: '60000'` so an expired analysis budget can retain affected tasks and publish a fallback report. A job killed by GitHub's `timeout-minutes` publishes no selection outputs or report. Set an internal deadline if you need that graceful fallback.

Analysis stops when every task has a decision. To avoid analysis entirely when you want all jobs, bypass the action in your workflow, as the main-branch quick start does. Compare selector usage with your own CI timings when assessing savings.

For exact input limits and custom Jev-compatible providers, see the [input reference](docs/reference.md#inputs) and [provider contract](docs/reference.md#provider-contract).

## Migrating to workflow-owned execution rules

This is a breaking input and report change. Before updating the action revision:

1. **Remove `mode` and `force-all`.** Nonblank values, including `mode: enforce` and `force-all: 'false'`, fail with a migration diagnostic. Observe selection by keeping CI jobs independent of its outputs; bypass the action to run everything without analysis.
2. **Remove `always` and `force_paths` from every task.** These keys are rejected even when false or empty. Put mandatory jobs and any path rules in the caller workflow. Keep each task's `description`; older `jobs`, `context_files` and `resolve_context_files` keys also remain unsupported.
3. **Choose where to call the action.** Workflow changes now receive ordinary analysis, and valid pushes use the exact before/after range. Main-branch full execution belongs to your workflow, as shown above. Zero SHAs, unavailable refs, fork PRs and failed or incomplete analyses still retain tasks conservatively.
4. **Update report consumers to v10.** The `mode` field and voluntary forcing reasons are gone. `tested_ref` can be `push`; `diff_base_sha` then identifies the exact `before` commit. Use the matching schema and analyzer. Existing analysis budgets keep their meanings.

The evaluation replay checks the current request and selection plumbing with self-authored mock choices. It does not test a live provider or establish Jev classification accuracy or CI savings. A false skip remains possible, so compare proposals with your own CI results before enforcing them.

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

Tests use temporary Git repositories, mocked HTTP and the shipped bundles. Evaluation replay uses self-authored mock choices without a key or network; see [evaluation details](docs/evaluation.md).

Commit regenerated bundles with their sources. `npm run check:dist` checks reproducibility. The action and standalone analyzer include their dependency license notices.

Released under the [MIT license](LICENSE).
