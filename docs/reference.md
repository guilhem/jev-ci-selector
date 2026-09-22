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
| `api-base-url` | `https://api.typesafe.ai` | HTTPS Jev System One root |
| `api-model` | `model` | Provider identifier, possibly an alias |
| `api-key` | Empty | Provider Bearer key; absent means no call and all tasks |
| `allow-external-context` | `'false'` | Explicit authorization to send diff, job metadata and context files |
| `github-token` | `${{ github.token }}` | GitHub token; ordinarily `contents: read` |
| `tested-ref` | `merge` | `merge` or `head` |
| `pull-request` | Empty | Open PR number for `workflow_dispatch`; add `pull-requests: read` |
| `force-all` | `'false'` | All tasks, no Jev request |
| `timeout-ms` | `10000` | Integer from 1 to 2147483647; shared context-preparation and analysis deadline, started once the inventory is built |
| `max-collected-patch-bytes` | `1048576` | Positive safe integer; UTF-8 patch bytes Git actually produced, rejected and retried attempts included |
| `max-analysis-bytes` | `524288` | Positive safe integer; complete request JSON sent to the API, preparation and observation together |
| `max-jev-calls` | `16` | Positive safe integer; API calls dispatched, failures included |

Boolean inputs accept only `true` and `false`; quote them in YAML. Integers use decimal integer syntax, without permissive suffix parsing.

`max-diff-bytes` has been removed. The action no longer builds a complete diff, so the input has no meaning it could keep; supplying it fails with a migration diagnostic rather than being reinterpreted. Replace it with `max-collected-patch-bytes`, whose value bounds a different thing: the patch text actually read, not the size of a whole diff. Runs pinned to an earlier release are unaffected.

Every budget counts what it names: real UTF-8 or JSON bytes produced or sent, and calls actually dispatched. None of them is a token count or an estimate of one. Beyond these three, the inventory ceiling, the per-unit patch ceiling, the per-request ceilings and the Git timeouts are fixed constants, centralized in `src/budget.ts` and `src/observations.ts`.

`max-collected-patch-bytes` bounds the **work**, not the useful context: a read that Git interrupted, and a patch produced in full but then rejected as binary or unrepresentable, are both charged. The report separates the two, as `analysis.patch_bytes_read` and `analysis.patch_bytes_delivered`. An interrupted read contributes a lower bound, never an exact size.

`timeout-ms` keeps its historical meaning — the shared deadline for context preparation and analysis — and its clock starts once the comparison is verified and the inventory is built. A slow fetch therefore cannot silently consume the analysis allowance. Git commands keep their own separate timeouts, and no read or call is started once the deadline has passed.

There are no per-task providers or budgets, no file path interpretation of `tasks`, and no configuration source precedence.

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
| `context_files` | Optional list of repository-relative paths; explicitly requested files are always retained |
| `resolve_context_files` | Boolean, default `false`; `true` opts into experimental discovery, while job evidence and explicit files remain available in both modes |
| `always` | Boolean, default `false`; forces execution |
| `force_paths` | Optional list of positive globs; a match forces execution |

A job reference has required `workflow` and optional `job`. Omitting `job` includes every job of that workflow. No other reference fields are accepted. Metadata includes job and step names, commands, action references and their declared inputs, relevant package scripts and explicitly requested context files. A description alone is complete; when no job is declared, it supplies the context anchor. Optional metadata enriches the same evaluation pipeline.

When `resolve_context_files` is enabled, context is prepared per real workflow/job. Tasks sharing several jobs receive the union of their job context. Preparation has two passes over all tracked Git paths without a lexical or language filter: the first discovers paths, and the second reads and qualifies those paths while discovering additional paths before reading them. The selected diff judgment follows preparation. Explicit `context_files` are always retained in the prepared context, whether discovery is enabled or disabled.

Requests batch candidate paths and full source files within the existing byte limits. Unread paths are considered against each source batch; a positive or uncertain judgment retains the candidate. Files are not silently truncated. The questions seek operational evidence for the specific job, not every file it processes or general documentation on the same topic.

Preparation uses the trusted metadata SHA for every read and never executes repository code. It has no persistent cache. A stable preparation request body excludes pull-request, diff and global commit metadata; changing relevant file content changes the corresponding body. The shared `timeout-ms` budget covers preparation and final evaluation, with at most three concurrent requests, a ten-second limit per request and no retries. Budgets are not expanded automatically. Context resolution is generic and does not infer TypeScript-specific semantics.

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

Jev classifies each change group as `required`, `independent` or `unresolved` for each task. Only `independent` for every group permits exclusion. `required` and `unresolved` retain the task; missing or invalid answers retain affected tasks through the incomplete-observation fallback. The provider's selected option controls the decision; its raw distribution and confidence are preserved without a numeric threshold or local argmax. Use shadow mode to assess selection on representative changes.

`always`, matching task paths and workflow changes impose execution. Workflow `needs` remains the only execution dependency mechanism: keep prerequisites mandatory where necessary.

Forks, missing key or consent, and `force-all` bypass Jev and keep all tasks. Unusable diffs, deadlines and incompatible or incomplete responses retain tasks conservatively. Sources that are too large, unreadable or incomplete retain affected tasks; deterministic policy remains authoritative. Preparation failure is scoped to the affected resolved task: it is marked to run, its synthetic `always` reason is removed, `context-resolution-incomplete` is added, and the plan becomes `fallback` unless an existing bypass already controls it. Complete or explicitly unrelated tasks may still be skipped. Final observation incompleteness keeps the existing global fallback behavior. A requested but unavailable metadata reference retains the affected task; omitting references deliberately is valid. Shadow mode keeps all effective outputs true while recording proposals, and enforce mode applies the same conservative policy decisions.

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

Nothing is read before the deterministic rules have run:

1. Inputs and event are validated, then the existing bypasses apply, without any repository access.
2. The comparison is verified: SHAs, merge base and merge parents.
3. The manifest is inventoried from `diff --raw`: names, modes and object ids. No `numstat`, no similarity search, no blob read and no patch. Rename detection is off, so a rename appears as a deletion plus an addition and both paths stay visible to `force_paths` and the protected-path rule.
4. The deterministic policy selects the tasks whose execution is already settled.
5. Only the remaining candidates have their job metadata and context resolved.
6. Patch text is then collected one bounded unit at a time, and only while some task is still open.
7. Each unit is grouped and evaluated; a task whose execution becomes acquired is removed from every request that has not started.
8. Analysis stops as soon as no candidate can still change state.

In `enforce`, a selection where every task is already required reads no patch, resolves no metadata or context, and dispatches no API call. A global protection such as a workflow edit has the same effect. In `shadow`, every task is still observed so evaluation campaigns keep seeing a proposal, while the effective outputs stay unchanged.

An exclusion requires complete coverage: every inventoried change must have been read and judged independent for that task. An unread change never becomes independent by default, and an incomplete inventory authorizes no new exclusion. Failures are scoped to the tasks they concern, so one task retained for lack of evidence does not erase another task's complete decision; the root status is then `fallback` while already-qualified outputs stay `false`.

## Report v8

The report is persisted and validated before outputs are published. The [strict schema](../schemas/report.schema.json) is authoritative; historical report versions are rejected and the current analyzer accepts only v8.

Version 8 follows the removal of the whole-diff step. `diff_hash` and `diff_bytes` stay `null` whenever no complete diff was built, which is the normal case: they are not back-filled by a read nothing else needed. The inventory is identified by `manifest.hash` instead, and groups carry `change_ids` and a `unit_index` rather than offsets into a global diff that does not exist.

| Group | Fields |
| --- | --- |
| Version | `version: 8` |
| Commits | `base_sha`, `head_sha`, `tested_sha`, `tested_ref`, `diff_base_sha` |
| Metadata | `metadata_sha`, `job_metadata` |
| Definition | `selection_hash` |
| Inventory | `manifest.complete`, `manifest.hash`, `manifest.change_count`, `changed_path_count` |
| Collection | `analysis.patches_requested`, `analysis.patches_read`, `analysis.patch_bytes_read`, `analysis.patch_bytes_delivered`, `analysis.changes_read`, `analysis.changes_total` |
| Inference | `analysis.preparation_calls`, `analysis.preparation_bytes`, `analysis.observation_calls`, `analysis.observation_bytes`, `analysis.jev_calls`, `analysis.analysis_bytes`, `analysis.limits_reached` |
| Coverage | `analysis.analysed_tasks`, `analysis.required_without_analysis`, `analysis.task_states`, `analysis.coverage`, `analysis.fallback_scope`, `analysis.fallback_tasks` |
| Legacy diff | `diff_hash`, `diff_bytes` (null unless a complete diff was built) |
| Execution | `mode`, `status`, `durations_ms`, `usage` |
| Model | `model.requested`, `model.expected`, `model.returned` |
| Decisions | `tasks` |
| Observations | `observation`, `observation_error` |
| Context resolution | `context_resolution` |

`metadata_sha` is the reference revision for metadata even when no task requests it. `selection_hash` is SHA-256 of canonical JSON `{ model, tasks }` after normalization and defaults: recursively sorted object keys, preserved array order. YAML formatting does not change it.

Each task decision contains `proposed_run`, `run` and `reasons`. Judgments live in observations by group. Observations include groups, requests, judgments, errors, models, usages and durations. `context_resolution` records task IDs, complete or incomplete status, context errors, trusted source paths with SHA-256 hashes and preparation passes. Calls record paths, request hashes, status, judgments, model, usage, duration and a fixed error code. It contains no file contents, raw source, diffs, secrets or provider error text. An empty object represents disabled or bypassed context resolution.

`analysis.changes_read` against `analysis.changes_total` says how much of the inventory the analysis actually reached. A lower `changes_read` is how an early stop is recognised, including when it happens between two collection units and therefore materialises no skipped group at all: the observation is then `stopped-early`, never `complete`.

`analysis.task_states` reports the per-task outcome: `settled-run` for an acquired execution, `settled-skip` for an exclusion backed by complete coverage, `fallback-run` for a task retained for lack of evidence, and `pending` only if analysis never reached it. `analysis.coverage` is true only when every obligation was really discharged. A group whose status is `not-needed` was skipped because every task was already decided; that is a success of the decision, reported as `stopped-early`, and never a timeout. `analysis.limits_reached` names the budgets that were actually hit.

Each observed chunk has a nullable `judgments` map of task IDs to `{ choice, probabilities, confidence }`. The exact three probability keys are `required`, `independent` and `unresolved`. Model-based policy reasons are `jev-independent` or `jev-not-independent`. No cross-group probability is synthesized.

Context judgments use the `inspect`/`ignore`/`uncertain` or `keep`/`discard`/`uncertain` option sets, with bounded numeric probabilities and confidence. Preparation sources that are too large, unreadable or incomplete do not authorize skipping. The root `usage` includes preparation and final evaluation usage. Stable preparation bodies and request hashes make externally managed caching possible, but the action has no persistent cache and does not claim a performance result.

The summary leads with mode, status, actual decisions, shadow proposals and fallback reasons. Detailed observations are secondary; reports and artifacts are optional for normal use.

## Release and development

Examples target `v0.1.0`; publication is separate from implementation. Pin a published release commit when immutable references are needed. This breaking API requires inline tasks; choose `mode: shadow` explicitly for observation.

Use Node.js 24, `npm run build`, `npm run check` and `npm run eval:replay`. Example consistency checks live in this repository's tests, not in scripts installed by consumers.
