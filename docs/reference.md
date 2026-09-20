# Action reference

[← Back to the README](../README.md) · [Shadow mode guide](shadow-mode.md) · [paths-filter migration](paths-filter.md) · [Security](../SECURITY.md)

`jev-ci-selector` produces a CI task selection plan. It does not execute tasks, generate commands, discover tests, or create a dynamic GitHub Actions job graph. Consumers own runners, secrets, commands, and execution order. The release-ready examples use `guilhem/jev-ci-selector@v0.1.0` as a target reference; the tag is not assumed to be published until the release. Replace it with the release commit SHA when immutable pinning is required.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `config` | `.github/task-routing.yaml` | Repository-relative path to the trusted catalog |
| `mode` | `shadow` | `shadow` records a proposal; `enforce` applies it |
| `pull-request` | Empty | On `workflow_dispatch`, evaluate this open PR using the selected workflow commit's catalog; requires `pull-requests: read` |
| `tested-ref` | `merge` | Analyze and output the verified merge commit, or `head` with its verified Git merge-base |
| `github-token` | `${{ github.token }}` | Fetch immutable Git objects with `contents: read` |
| `api-key` | Empty | Bearer key for the selected provider; no key means full CI without Jev |
| `api-base-url` | `https://api.typesafe.ai` | HTTPS Jev System One provider base URL; the SDK appends `/v1/systemone` |
| `api-model` | Catalog `model` | Provider model alias; the response must still identify the catalog's canonical model version |
| `allow-external-context` | `false` | Explicit permission to send the diff and metadata to the configured API |
| `force-all` | `false` | Immediately bypass selection and keep every task |
| `timeout-ms` | `10000` | Total evaluation deadline; up to three concurrent calls, at most ten seconds each, no retries |
| `max-diff-bytes` | `65536` | Maximum complete UTF-8 diff size; not a token count |

Boolean inputs accept only `true` and `false`. Quote them as strings in workflow YAML. Budgets must be positive integers; the timeout cannot exceed Node's timer limit of `2147483647` ms. `config` must be a relative path within the repository.

An empty `api-base-url` uses the default, and an empty `api-model` uses the catalog model. A custom model identifier is limited to 128 ASCII letters, digits, `.`, `_`, `:`, `/`, and `-`, starting with a letter or digit. Invalid API configuration fails the planner before any network access. These explicit inputs take precedence over SDK environment variables.

Diagnostics name the invalid input and the fixed expected constraint, never the supplied value. This applies to `mode`, `tested-ref`, boolean inputs, integer budgets, `api-base-url`, and `api-model`; raw exceptions and provider error bodies are not exposed.

## Outputs

All output values are strings. Parse JSON outputs with `fromJSON(...)` in GitHub Actions expressions. Task keys and arrays use stable identifier order. Every catalog task also has a direct output named after its task ID. Direct task outputs are the exact strings `true` or `false` and equal the corresponding effective value in `run`.

| Output | Content |
| --- | --- |
| `run` | JSON object with an effective boolean for every catalog task |
| `selected` | JSON array of effective task IDs |
| `matrix` | JSON object shaped as `{"include":[{"task":"…"}]}` |
| `has-tasks` | `"true"` or `"false"`; check at job level before matrix expansion |
| `status` | `planned`, `bypassed`, or `fallback` |
| `tested-sha` | Immutable commit that consumer jobs must test |
| `report-path` | Local path to the detailed JSON report on the planning runner |
| `<task-id>` | Exact string `true` or `false` for that task's effective run decision |

In `shadow`, every direct task output is `"true"`, every `run` value is `true`, and `selected` and `matrix` include every task, even when the proposal is empty. Bypassed and fallback plans also set every task to `true`. The hypothetical selection appears only in `tasks.*.proposed_run` in the report.

`enforce` applies the selection after adding mandatory tasks. Execution dependencies stay in the workflow. Changing to this mode is an explicit consumer decision.

## Catalog rules

The [JSON Schema](../schemas/config.schema.json) defines the complete format. The catalog requires a pinned model such as `jev-1.13.0`, a `skip_below` threshold in `[0, 1]`, and a `tasks` object. Model aliases are rejected.

| Field | Effect |
| --- | --- |
| `always: true` | Keep this task regardless of Jev's assessment |
| `force_paths` | Keep the task when any changed path matches; a match is mandatory and no match leaves it eligible for semantic evaluation |
| `description` | Describe the behavior, artifacts and verification machinery covered by the task |
| `jobs` | One or more workflow/job references whose trusted metadata describes the task |
| `force_all_paths` | Top-level patterns that force every task when matched |

Every task requires a nonempty description and at least one job reference, including mandatory tasks. Both modes observe all configured tasks, so raw model answers remain separate from deterministic policy. Use `force_paths` only for narrow must-run cases. Descriptions explain verification scope; the action constructs the Noul questions.

An optional task may be excluded only when every required group probability is **strictly below** `skip_below`. Equality keeps the task. The initial `0.05` value is experimental and does not guarantee an error rate.

### Job references

Each task has a nonempty `jobs` array. A reference contains `workflow` and may omit
`job` to include every job in that workflow. `context_files`, `always`, and
`force_paths` are optional. Legacy `version`, `question`, `requires`, and direct
`workflow`/`job` task fields are rejected.

```yaml
model: jev-1.13.0
skip_below: 0.05
tasks:
  unit:
    description: Runs unit behavior tests.
    jobs:
      - workflow: .github/workflows/ci.yml
        job: unit
    context_files: [vitest.config.mts]
```

Job names, step names/commands/action references, supplied action inputs, working
directories, shells, called package scripts, action names/descriptions, and explicit
context files come from the trusted configuration commit. External action references
are resolved to a commit SHA. Missing evidence is reported and cannot justify
skipping the affected task. No scripts or configurations are executed, and native
workflow dependencies remain owned by GitHub Actions.

### Paths

Patterns use `minimatch` with hidden files included and with negation and comments disabled. Paths are relative, case-sensitive, and use `/` separators. Renames include both old and new paths.

The exact configured catalog path and every path under `.github/workflows/` always force full CI, independently of `force_all_paths`.

### Validation

Duplicate YAML keys, aliases, unknown properties, and tasks without a description or usable job reference are rejected. Identifiers follow `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Task IDs must be unique case-insensitively and cannot collide case-insensitively with another task, any standard output (`run`, `selected`, `matrix`, `has-tasks`, `status`, `tested-sha`, or `report-path`), or the existing reserved IDs such as `plan`, `ci-required`, `ci-contract`, `tasks`, and `prototype`; the schema lists the static reserved names.

An empty catalog is valid and produces `has-tasks: 'false'`. A missing, unreadable, or invalid catalog is a planner failure, because the action cannot identify what “all tasks” means.

Job references do not turn workflow `needs` into selector dependencies. Declare the real execution dependencies with `needs` in your workflow. A matrix does not schedule these dependencies; use independent tasks or separately executed common prerequisites.

## Status and failure behavior

| Situation | Status | Result |
| --- | --- | --- |
| Selection calculated, including an entirely deterministic plan | `planned` | Apply the chosen mode |
| `force-all`, fork PR, missing key, or no external-context permission | `bypassed` | All tasks; no Jev call |
| Protected catalog/workflow path or configured force-all path | `bypassed` | All tasks; both modes still observe configured tasks |
| Non-PR event | `bypassed` | The action reads the catalog at `github.sha`, makes no Jev call, and returns all tasks |
| Timeout, API/network error, rate limit, or invalid/partial response | `fallback` | All tasks |
| Incomplete, oversized, incoherent, or unsupported diff | `fallback` | All tasks |
| Missing or invalid catalog | No valid plan | Planner fails |
| Internal error preventing a coherent plan | No valid plan | Planner fails |

A fallback is a valid full plan. The final `ci-required` gate must reject a failed planner or invalid plan, and must verify that every selected task actually succeeded.

### Custom workflow gates

The supplied static and matrix templates include `dist/validate.cjs` copied as `.github/ci-selector-validate.cjs`. That validator is mandatory inside those fixed templates because it checks their known catalog, launcher, prerequisite, and gate contract. It is not required for the independent observer or for an arbitrary custom workflow.

For a larger or differently shaped catalog, publish the aggregate `run` output and validate it in the final gate. The following is a wiring excerpt only: it omits `runs-on`, the selector step, checkout/setup, and the implementation of the trusted validator script.

```yaml
jobs:
  plan:
    outputs:
      run: ${{ steps.select.outputs.run }}
      tested-sha: ${{ steps.select.outputs.tested-sha }}

  ci-required:
    needs: [plan, unit, build]
    if: ${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - name: Validate the plan directly
        env:
          PLAN_RUN: ${{ needs.plan.outputs.run }}
          NEEDS_JSON: ${{ toJSON(needs) }}
        run: node .github/validate-plan.mjs

  unit:
    needs: plan
    if: ${{ always() && needs.plan.result == 'success' && fromJSON(needs.plan.outputs.run).unit == true }}
```

Use `fromJSON(...)` only in GitHub Actions expressions, such as the `unit` condition above. The Node validator should use `JSON.parse(process.env.PLAN_RUN)` and `JSON.parse(process.env.NEEDS_JSON)`, then check that the keys and boolean values match the trusted catalog, check the required prerequisites, and require success for every task whose value is `true`. There is no named-output requirement: named task outputs are a convenience of the static template. Do not use the supplied template validator to imply coverage for a custom catalog or launcher.

## Commit and diff collection

For a pull request, the event fixes all four SHA values:

```text
config_sha = event.pull_request.base.sha
base_sha   = event.pull_request.base.sha
head_sha   = event.pull_request.head.sha
tested_sha = GITHUB_SHA

diff = base_sha → tested_sha
```

With `tested-ref: head`, `tested_sha` is the event's exact head SHA and the diff is
`merge-base(base_sha, head_sha) → head_sha`. The unique merge-base is read from Git
history and recorded as `diff_base_sha`; missing or ambiguous history is not guessed.

For automatic PR events, the catalog comes from the **base Git object**, never from the PR's edited copy. The tested commit must have exactly `[base_sha, head_sha]` as its two parents. Branch names are never silently resolved to their latest state, so an older run remains tied to its own event.

A manual `workflow_dispatch` with `pull-request` deliberately takes a new snapshot of the chosen open PR through the GitHub API. It uses that response's immutable base, head and merge SHAs, and still verifies the merge parents. The catalog comes from `GITHUB_SHA`, the workflow revision selected by the operator, and is recorded separately in `config_sha`. This makes it possible to test a reviewed catalog before merging it. Manual evaluation supports both modes; it returns a plan and never executes any job itself. It observes the current PR, not an arbitrary historical run. With `tested-ref: merge`, a missing merge commit fails without guessing or polling; `head` does not require a merge commit.

If required objects can no longer be fetched, the action keeps all tasks, or fails if the trusted catalog itself is unavailable. Consumer jobs must check out `tested-sha`.

Collection uses a temporary bare Git repository, argument arrays, and exact-SHA fetches. Merge collection starts at depth `1`; head collection obtains history to verify the merge-base. There is no checkout, submodule initialization, dependency installation, or execution of project scripts. External diff programs, text conversion, hooks, and external Git configuration are disabled.

Additions, deletions, renames, and mode changes are included. Binary content, changed gitlinks, invalid UTF-8, and incomplete or oversized output force full CI. A truncated diff is never used to justify skipping a task. When a bypass is known before collection, no diff hash is invented.

Implementation limits also cap the catalog at 1 MiB (a blocking error), Git metadata at 4 MiB, and each inspected blob at 16 MiB (full CI if collection cannot complete).

## Jev requests and reports

The official SDK sends structured Noul questions: does this group concern the
behavior verified or artifact produced by the supplied job? Criteria explicitly
exclude sharing generic installation steps as sufficient evidence. This is not a
prediction of test failure. Independent job questions share one state.

Both modes group files deterministically by directory and declared working
directories. Whole files stay together when they fit; oversized files split at
hunks or complete lines with identifying headers. Groups cover every source byte.
Each state contains only that group's paths, never the paths of unrelated groups.
An unrepresentable line or exhausted context budget remains an explicit failure.

Request guards include serialized questions and JSON escaping: 64 KiB per state
plus largest question, 128 KiB for state plus a batch of questions, at most 64 groups and
three concurrent calls. These are byte guards, not exact token counts. The global
deadline preserves completed responses and identifies failed or unstarted groups.

Selection is composed as booleans: any relevant group keeps a job; omission needs
all required groups below the threshold. Dependencies are then included. No
maximum, average or product is published or used as a global probability. Partial
evidence retains its scores; incomplete evidence cannot justify an omission.
Policy reasons and observation errors remain separate.

Version 4 is the current report shape. It keeps `config_sha`, `base_sha`,
`head_sha`, `tested_sha`, `catalog_hash`, `diff_hash`, `mode`, `status`, model
configuration, timings, usage, and task decisions, and adds `tested_ref`,
`diff_base_sha`, `job_metadata`, `observation_error`, and the v4 observation.
`config_sha` identifies the trusted catalog/workflow revision: the PR base SHA for
automatic pull requests and the selected `GITHUB_SHA` for manual observation.
Reports record metadata provenance and hashes, group paths/ranges/hashes, raw
scores, model, token usage, timings, and evaluation status. They never include
patches, file contents, question bodies, API credentials, or provider error bodies.
Task `probability` is null; `proposed_run` and reasons explain the composed decision.

When all job questions do not fit together, independent questions share the same group state in bounded batches. Each request lists its job IDs and evaluation status; completed answers survive failures in another batch.

Workflow-level `defaults` and `env` retain their native values and provenance. Package scripts in composite actions are read from the caller workspace and the declared step directory. Shell directory switches, package-manager workspace/directory switches, and reusable workflows that cannot be resolved are marked incomplete and retain the affected job; they are never attributed to a guessed manifest.

## Development

The source shadow analyzer is `scripts/analyze-shadow.mjs`. The release bundle
`dist/analyze-shadow.mjs` is standalone and runs with Node.js 24; copy it from the
same release as the action together with `dist/licenses.txt` when distributing it.
Use either command with a report and manually prepared results file:

```sh
node dist/analyze-shadow.mjs report.json results.json
npm run analyze:shadow -- report.json results.json
```
