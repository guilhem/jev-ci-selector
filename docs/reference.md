# Action contract

The action selects tasks and publishes outputs. Workflows own execution, secrets, runners and ordering. Prepare descriptions by inspecting the real CI jobs before editing the workflow, for example with the [describe-ci-jobs skill](../skills/describe-ci-jobs/SKILL.md). Save them in the required inline `tasks` input. The skill is an authoring aid; CI runs only this action, which sends descriptions and the diff to Jev.

## Compatibility and versions

This description-only task contract and report v9 are breaking changes. The [examples](../examples/static-jobs/README.md) use moving `@main` after this change reaches that branch; pin the resulting commit SHA for reproducible CI. No new release tag is assumed. The report and canonical Jev model versions evolve independently of an action release. Consumers of reports must validate the version and use a matching analyzer.

Older action revisions keep their own input and report contracts.

## Inputs

GitHub passes strings. Validation and normalization precede Git or HTTP access, including manual PR resolution. Blank optional inputs use their defaults.

| Input | Default | Contract |
| --- | --- | --- |
| `tasks` | Required | YAML table of task objects; no enclosing `tasks:` key |
| `mode` | `enforce` | `enforce` applies selection; `shadow` keeps every task |
| `model` | `jev-1.13.0` | Canonical version expected in the response, `jev-X.Y.Z` |
| `api-base-url` | `https://api.typesafe.ai` | HTTPS Jev System One root |
| `api-model` | `model` | Provider identifier, possibly an alias |
| `api-key` | Empty | Provider Bearer key; absent means no call and all tasks |
| `allow-external-context` | `'false'` | Explicit authorization to send changed paths, patch text and task descriptions |
| `github-token` | `${{ github.token }}` | GitHub token; ordinarily `contents: read` |
| `tested-ref` | `merge` | `merge` or `head` |
| `pull-request` | Empty | Open PR number for `workflow_dispatch`; add `pull-requests: read` |
| `force-all` | `'false'` | All tasks, no Jev request |
| `timeout-ms` | `0` | `0` for no deadline, else 1 to 2147483647; analysis deadline starting after comparison and inventory |
| `max-collected-patch-bytes` | `0` | `0` for none; patch bytes received on stdout, rejected and retried attempts included |
| `max-analysis-bytes` | `0` | `0` for none; complete analysis request JSON sent to the API |
| `max-jev-calls` | `0` | `0` for none; analysis API calls dispatched, failures included |

Boolean inputs accept only `true` and `false`; quote them in YAML. Integers use decimal integer syntax, without permissive suffix parsing.

`max-diff-bytes` has been removed. The action no longer builds a complete diff, so the input has no meaning it could keep; supplying it fails with a migration diagnostic rather than being reinterpreted. Replace it with `max-collected-patch-bytes`, whose value bounds a different thing: the patch text actually read, not the size of a whole diff. Runs pinned to an earlier release are unaffected.

All four ceilings default to `0`, meaning no action-level ceiling. The provider's window and rate limits and the job's `timeout-minutes` still apply. Byte and call limits count measured work, not estimated tokens.

Requests are sized against the provider window using a bytes-per-token ratio updated from response usage. Oversized payloads can be split and retried. Analysis concurrency adapts to rate limits; the same analysis budget covers the path inventory assessment and change-group judgments.

`max-collected-patch-bytes` bounds the **work**, not the useful context: a read that Git interrupted, and a patch produced in full but then rejected as binary or unrepresentable, are both charged. The report separates the two, as `analysis.patch_bytes_read` and `analysis.patch_bytes_delivered`.

`patch_bytes_read` counts bytes received on the command's standard output, a timeout after partial output included. It measures what Git delivered, not the work Git performed internally, and the chunk that crosses a ceiling is reported as received rather than clamped to that ceiling — so a read can be charged slightly more than its cap, and the report shows the overshoot instead of hiding it.

`timeout-ms` starts after the comparison is verified and the inventory is built. Git fetch and comparison have separate timeouts. At `0`, a job killed by GitHub's `timeout-minutes` publishes **no report and no outputs**; set an internal deadline if a graceful fallback is needed.

There are no per-task providers or budgets, no file path interpretation of `tasks`, and no configuration source precedence.

## Tasks

```yaml
tasks: |
  integration:
    description: >
      Verifies HTTP authentication and PostgreSQL persistence using a migrated
      test database. API routes, authentication rules, migrations and test setup
      are inputs; browser rendering is outside this job's scope.
    force_paths: [migrations/**]
  lint:
    description: Verifies TypeScript ESLint rules.
    always: true
```

| Field | Contract |
| --- | --- |
| `description` | Required nonblank string describing verification scope |
| `always` | Boolean, default `false`; forces execution |
| `force_paths` | Optional list of positive globs; a match forces execution |

The action reads no job metadata or context files at runtime. Use the [skill](../skills/describe-ci-jobs/SKILL.md) while authoring to inspect job commands, scripts, test configuration and consumed files, then save the relevant verification scope in `description`. `jobs`, `context_files` and `resolve_context_files` are no longer accepted; remove them and move their useful evidence into the description. They have no legacy mode.

IDs match `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` and are unique ignoring case. Standard output names and dangerous JavaScript property names are reserved by the [schema](../schemas/tasks.schema.json). Job names such as `plan` and `ci-contract` are not reserved task IDs.

Unknown fields, duplicate YAML keys, YAML aliases, blank descriptions and incorrect types are rejected. A string is not a task object. `force_paths` globs must be relative, without absolute paths, `..` traversal or NUL characters. Globs are positive must-run rules using the action's existing minimatch semantics; absence of a match does not authorize skipping. This is not the full paths-filter syntax.

Missing or blank `tasks` fails. An explicit `{}` is valid and yields no selected tasks and no Jev requests.

## Provider contract

The SDK appends `/v1/systemone` to `api-base-url`, retaining a path prefix. The endpoint must implement Jev System One; an OpenAI-style chat endpoint cannot be substituted.

HTTPS is required. Embedded credentials, query strings, fragments, spaces, control characters and backslashes are rejected before network access. `api-model` has 1–128 ASCII characters from letters, digits, `.`, `_`, `:`, `/`, `-`, starting with a letter or digit. The provider response must identify the exact canonical `model`, even when an alias was requested.

Redirects and automatic alternate providers are disabled. Transient faults and rate limits can be retried within the call's wall-clock budget; the transport and report count actual attempts. Analysis concurrency adapts to rate limits. Explicit settings prevent SDK environment variables from changing the provider or enabling request/response body logging.

## Events, provenance and selection

Automatic PR analysis uses verified immutable Git objects. `tested-ref: merge` tests the verified event merge commit; `head` uses the verified PR head and merge-base. Consumer jobs should check out `tested-sha`.

Task definitions are inputs of the executed workflow, not data reread from the base branch. Manual PR evaluation uses those workflow inputs and resolves only the PR and tested diff SHAs. The action cannot reconstruct a task removed from its inputs.

A `workflow_dispatch` with `pull-request` evaluates that open PR using the same pipeline. Other events keep every task without a Jev request. This includes push, schedule and merge groups; semantic selection on those events is not provided.

Jev classifies each change group as `required`, `independent` or `unresolved` for each task. Only `independent` for every group permits exclusion. `required` and `unresolved` retain the task; missing or invalid answers retain affected tasks through the incomplete-observation fallback. The provider's selected option controls the decision; its raw distribution and confidence are preserved without a numeric threshold or local argmax. Use shadow mode to assess selection on representative changes.

`always`, matching task paths and workflow changes impose execution. Workflow `needs` remains the only execution dependency mechanism: keep prerequisites mandatory where necessary.

Forks, missing key or consent, and `force-all` bypass Jev and keep all tasks. Unusable diffs, deadlines and incompatible or incomplete responses retain affected tasks conservatively. Binary, submodule, oversized or unreadable changes cannot authorize a skip. A fallback scoped to one task does not erase another task's complete independent decision; an unusable comparison or incomplete inventory causes a global fallback. Shadow mode keeps all effective outputs true while recording proposals, and enforce mode applies the same conservative policy decisions.

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

Named and aggregate outputs agree. Shadow and bypass retain all declared tasks. Fallback retains affected tasks; a global fallback retains every task. For `{}`, `run` is `{}`, `selected` is `[]`, `matrix` has an empty `include`, and `has-tasks` is `false`.

Use `steps.select.outputs.unit == 'true'` within a job, or forward it through job outputs for `needs.selection.outputs.unit == 'true'`. Check `has-tasks` before matrix expansion. Keep existing CI failure gates; the action does not make a skipped consumer job prove that planning succeeded. [Static](../examples/static-jobs/README.md) and [matrix](../examples/matrix/README.md) examples include advanced final gates.

## Analysis order and budgets

The action reads no repository source or patch before deterministic rules have run:

1. Inputs and event are validated, then the existing bypasses apply, without any repository access.
2. The comparison is verified: SHAs, merge base and merge parents.
3. The manifest is inventoried from `diff --raw`: names, modes and object ids. No `numstat`, no similarity search, no blob read and no patch. Rename detection is off, so a rename appears as a deletion plus an addition and both paths stay visible to `force_paths` and the protected-path rule.
4. The deterministic policy selects the tasks whose execution is already settled.
5. Jev can assess the path inventory against the remaining task descriptions. This coarse pass can require a task to run but cannot authorize a skip.
6. Patch text is collected one bounded unit at a time, only while some task is still open.
7. Jev evaluates each change group against the remaining descriptions. A task whose execution becomes required is removed from requests that have not started.
8. In `enforce`, analysis stops as soon as no candidate can still change state.

In `enforce`, a selection where every task is already required reads no patch and dispatches no API call. A global protection such as a workflow edit has the same effect. In `shadow`, tasks are still observed so a proposal remains visible, while the effective outputs stay unchanged.

An exclusion requires complete coverage: every inventoried change must have been read and judged independent for that task. An unread change never becomes independent by default, and an incomplete inventory authorizes no new exclusion. Failures are scoped to the tasks they concern, so one task retained for lack of evidence does not erase another task's complete decision; the root status is then `fallback` while already-qualified outputs stay `false`.

## Report v9

The report is persisted and validated before outputs are published. The [strict schema](../schemas/report.schema.json) is authoritative; historical report versions are rejected and the current analyzer accepts only v9.

The root `diff_hash` and `diff_bytes` fields are removed. The complete inventory is identified by `manifest.hash`; observed groups have their own `diff_hash`, `diff_bytes`, `change_ids` and `unit_index`.

| Group | Fields |
| --- | --- |
| Version | `version: 9` |
| Commits | `base_sha`, `head_sha`, `tested_sha`, `tested_ref`, `diff_base_sha` |
| Definition | `selection_hash` |
| Inventory | `manifest.complete`, `manifest.hash`, `manifest.change_count`, `changed_path_count` |
| Collection | `analysis.patches_requested`, `analysis.patches_read`, `analysis.patch_bytes_read`, `analysis.patch_bytes_delivered`, `analysis.changes_read`, `analysis.changes_total` |
| Inference | `analysis.jev_calls`, `analysis.analysis_bytes`, `analysis.attempts`, `analysis.bytes_per_token`, `analysis.limits_reached` |
| Coverage | `analysis.analysed_tasks`, `analysis.required_without_analysis`, `analysis.task_states`, `analysis.coverage`, `analysis.fallback_scope`, `analysis.fallback_tasks` |
| Execution | `mode`, `status`, `durations_ms`, `usage` |
| Model | `model.requested`, `model.expected`, `model.returned` |
| Decisions | `tasks` |
| Observations | `observation`, `observation_error` |

`selection_hash` is SHA-256 of canonical JSON `{ model, tasks }` after normalization and defaults: recursively sorted object keys, preserved array order. YAML formatting does not change it. Report v9 removes `metadata_sha`, `job_metadata`, `context_resolution` and the preparation/observation budget counters.

Each task decision contains `proposed_run`, `run` and `reasons`. Judgments live in the observation's inventory assessment and change groups. Group calls record task IDs, request byte counts, status, model, usage, duration and a fixed error code. The report contains no file contents, raw source, diffs, secrets or provider error text.

`analysis.changes_read` against `analysis.changes_total` says how much of the inventory the analysis actually reached. A lower `changes_read` is how an early stop is recognised, including when it happens between two collection units and therefore materialises no skipped group at all: the observation is then `stopped-early`, never `complete`. The converse holds too — a change set read in full is `complete` even when the very last group settled the last task, and no extra read is performed merely to establish that.

`analysis.fallback_tasks` and `analysis.task_states` are derived from explicit retention reasons, not just a task's proposal. A task kept because its diff or judgment is unusable must appear in the fallback even when another task has enough evidence to skip.

`analysis.task_states` reports the per-task outcome: `settled-run` for an acquired execution, `settled-skip` for an exclusion backed by complete coverage, `fallback-run` for a task retained for lack of evidence, and `pending` only if analysis never reached it. `analysis.coverage` is true only when every obligation was really discharged. A group whose status is `not-needed` was skipped because every task was already decided; that is a success of the decision, reported as `stopped-early`, and never a timeout. `analysis.limits_reached` names the budgets that were actually hit.

Each observed chunk has a nullable `judgments` map of task IDs to `{ choice, probabilities, confidence }`. The exact three probability keys are `required`, `independent` and `unresolved`. Model-based policy reasons are `jev-independent` or `jev-not-independent`. No cross-group probability is synthesized.

The inventory assessment can retain tasks but cannot skip them. The root `usage` reports the analysis usage available from Jev; `analysis.jev_calls` and `analysis.analysis_bytes` are the total call and request-byte counters. No runtime context preparation or source-file discovery occurs.

The summary leads with mode, status, actual decisions, shadow proposals and fallback reasons. Detailed observations are secondary; reports and artifacts are optional for normal use.

## Release and development

Examples use moving `@main` after this change is merged; pin the resulting commit SHA when immutable references are needed. No new release tag is assumed. Choose `mode: shadow` explicitly for observation.

Use Node.js 24, `npm run build`, `npm run check` and `npm run eval:replay`. Example consistency checks live in this repository's tests. Evaluation replay uses self-authored mock choices to check technical request and selection plumbing; it does not measure live Jev classification accuracy.
