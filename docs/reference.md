# Action contract

The action selects tasks and publishes outputs. Workflows own execution, secrets, runners and ordering. There is one source of task definitions: the required inline `tasks` input.

## Compatibility and versions

The action follows Semantic Versioning. A major-version tag such as `v0` floats
to the latest stable release of that major version. A prerelease publishes its
exact tag only and never moves a floating tag. Pin a release commit when an
immutable reference is required. A major version boundary covers changes to the
input or output contract, the report version, or the default value of `mode`.

The report version and canonical Jev model version evolve independently from the
action version. Consumers that persist or analyze reports must validate the
report version and upgrade their analyzer deliberately.

## Inputs

GitHub passes strings. Validation and normalization precede Git or HTTP access, including manual PR resolution. Blank optional inputs use their defaults.

| Input | Default | Contract |
| --- | --- | --- |
| `tasks` | Required | YAML table of task objects; no enclosing `tasks:` key |
| `mode` | `enforce` | `enforce` applies selection; `shadow` keeps every task |
| `model` | `jev-1.13.0` | Canonical version expected in the response, `jev-X.Y.Z` |
| `skip-below` | `0.05` | Finite decimal in `[0, 1]`; strict exclusion threshold |
| `api-base-url` | `https://api.typesafe.ai` | HTTPS Jev System One root |
| `api-model` | `model` | Provider identifier, possibly an alias |
| `api-key` | Empty | Provider Bearer key; absent means no call and all tasks |
| `allow-external-context` | `'false'` | Explicit authorization to send diff and metadata |
| `github-token` | `${{ github.token }}` | GitHub token; ordinarily `contents: read` |
| `tested-ref` | `merge` | `merge` or `head` |
| `pull-request` | Empty | Open PR number for `workflow_dispatch`; add `pull-requests: read` |
| `force-all` | `'false'` | All tasks, no Jev request |
| `timeout-ms` | `10000` | Integer from 1 to 2147483647; total evaluation deadline |
| `max-diff-bytes` | `65536` | Positive safe integer; complete UTF-8 diff limit |

Boolean inputs accept only `true` and `false`; quote them in YAML. Integers use decimal integer syntax, without permissive suffix parsing. The threshold accepts decimal syntax, not NaN, infinity or suffixes. Zero is a valid threshold and prevents model-based exclusion.

There are no per-task providers, budgets or thresholds, no file path interpretation of `tasks`, and no configuration source precedence.

## Tasks

```yaml
tasks: |
  integration:
    description: Verifies HTTP authentication and PostgreSQL persistence.
    jobs:
      - workflow: .github/workflows/ci.yml
        job: integration
    context_files: [tests/integration/setup.ts]
    force_paths: [migrations/**]
  lint:
    description: Verifies TypeScript ESLint rules.
    always: true
```

| Field | Contract |
| --- | --- |
| `description` | Required nonblank string describing verification scope |
| `jobs` | Optional nonempty list of workflow/job references |
| `context_files` | Optional list of repository-relative paths |
| `always` | Boolean, default `false`; forces execution |
| `force_paths` | Optional list of positive globs; a match forces execution |

A job reference has required `workflow` and optional `job`. Omitting `job` includes every job of that workflow. No other reference fields are accepted. Metadata includes job and step names, commands, action references and their declared inputs, relevant package scripts and explicitly requested context files. A description alone is complete; optional metadata enriches the same evaluation pipeline.

IDs match `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` and are unique ignoring case. Standard output names and dangerous JavaScript property names are reserved by the [schema](../schemas/tasks.schema.json). Job names such as `plan` and `ci-contract` are not reserved task IDs.

Unknown fields, duplicate YAML keys, YAML aliases, blank descriptions and incorrect types are rejected. A string is not a task object. Paths must be relative, without absolute paths, `..` traversal or NUL characters. Globs are positive must-run rules using the action's existing minimatch semantics; absence of a match does not authorize skipping. This is not the full paths-filter syntax.

Missing or blank `tasks` fails. An explicit `{}` is valid and yields no selected tasks and no Jev requests.

## Provider contract

The SDK appends `/v1/systemone` to `api-base-url`, retaining a path prefix. The endpoint must implement Jev System One; an OpenAI-style chat endpoint cannot be substituted.

HTTPS is required. Embedded credentials, query strings, fragments, spaces, control characters and backslashes are rejected before network access. `api-model` has 1–128 ASCII characters from letters, digits, `.`, `_`, `:`, `/`, `-`, starting with a letter or digit. The provider response must identify the exact canonical `model`, even when an alias was requested.

There are no redirects, retries or automatic alternate providers. Evaluation uses at most three concurrent requests; each is bounded by ten seconds and the remaining total deadline. Explicit settings prevent SDK environment variables from changing the provider or enabling request/response body logging.

## Events, provenance and selection

Automatic PR analysis uses verified immutable Git objects. `tested-ref: merge` tests the verified event merge commit; `head` uses the verified PR head and merge-base. Consumer jobs should check out `tested-sha`.

Task definitions are inputs of the executed workflow, not data reread from the base branch. Requested metadata is read at the PR base commit; manual PR evaluation uses the operator-selected workflow revision. The action cannot reconstruct a task removed from its inputs.

A `workflow_dispatch` with `pull-request` evaluates that open PR using the same pipeline. Other events keep every task without a Jev request. This includes push, schedule and merge groups; semantic selection on those events is not provided.

An optional task is excluded only when all required observations are complete and their scores are strictly below `skip-below`. Equality retains the task. `always`, matching task paths and workflow changes impose execution. Workflow `needs` remains the only execution dependency mechanism: keep prerequisites mandatory where necessary.

Forks, missing key or consent, and `force-all` bypass Jev and keep all tasks. Unusable diffs, deadlines and incompatible or incomplete responses retain tasks conservatively. A requested but unavailable metadata reference retains the affected task; omitting references deliberately is valid. Shadow mode keeps all effective outputs true while recording proposals.

Invalid inputs fail without a plan, even with `force-all`. Unexpected internal failures remain failures. Error diagnostics name a known field and fixed constraint, never supplied values or raw YAML/provider errors.

## Outputs

All values are strings. JSON structures use stable task identifier order.

| Output | Value |
| --- | --- |
| `<task-id>` | Exact `true` or `false`, effective decision |
| `run` | JSON object of task booleans |
| `selected` | JSON array of selected IDs |
| `matrix` | JSON object `{"include":[{"task":"unit"}]}` |
| `has-tasks` | Exact `true` or `false` |
| `status` | `planned`, `bypassed` or `fallback` |
| `tested-sha` | Immutable tested commit |
| `report-path` | Runner-local JSON report path |

Named and aggregate outputs agree. Shadow, bypass and fallback retain all declared tasks. For `{}`, `run` is `{}`, `selected` is `[]`, `matrix` has an empty `include`, and `has-tasks` is `false`.

Use `steps.select.outputs.unit == 'true'` within a job, or forward it through job outputs for `needs.selection.outputs.unit == 'true'`. Check `has-tasks` before matrix expansion. Keep existing CI failure gates; the action does not make a skipped consumer job prove that planning succeeded. [Static](../examples/static-jobs/README.md) and [matrix](../examples/matrix/README.md) examples include advanced final gates.

## Report v5

The report is persisted and validated before outputs are published. The [strict schema](../schemas/report.schema.json) is authoritative; the current analyzer accepts only v5.

| Group | Fields |
| --- | --- |
| Version | `version: 5` |
| Commits | `base_sha`, `head_sha`, `tested_sha`, `tested_ref`, `diff_base_sha` |
| Metadata | `metadata_sha`, `job_metadata` |
| Definition | `selection_hash`, `skip_below` |
| Diff | `diff_hash`, `diff_bytes`, `changed_path_count` |
| Execution | `mode`, `status`, `durations_ms`, `usage` |
| Model | `model.requested`, `model.expected`, `model.returned` |
| Decisions | `tasks` |
| Observations | `observation`, `observation_error` |

`metadata_sha` is the reference revision for metadata even when no task requests it. `selection_hash` is SHA-256 of canonical JSON `{ model, skip_below, tasks }` after normalization and defaults: recursively sorted object keys, preserved array order. YAML formatting does not change it.

Each task decision contains `proposed_run`, `run` and `reasons`. Scores live in observations by group, not in a synthetic global task probability. Observations include groups, requests, scores, errors, models, usages and durations. Reports omit descriptions, file bodies, diffs, keys and provider error bodies.

The summary leads with mode, status, actual decisions, shadow proposals and fallback reasons. Detailed observations are secondary; reports and artifacts are optional for normal use.

## Release and development

Examples target `v0.1.0`; publication is separate from implementation. Pin a published release commit when immutable references are needed. This breaking API requires inline tasks; choose `mode: shadow` explicitly for observation.

Use Node.js 24, `npm run build`, `npm run check` and `npm run eval:replay`. Example consistency checks live in this repository's tests, not in scripts installed by consumers.
