# jev-ci-selector

[![Validate action](https://github.com/guilhem/jev-ci-selector/actions/workflows/ci.yml/badge.svg)](https://github.com/guilhem/jev-ci-selector/actions/workflows/ci.yml)

Describe what your CI checks verify. Jev evaluates the pull request diff and returns boolean outputs for your existing jobs.

The action selects tasks; your workflow owns commands, runners and dependencies. Selection is applied by default (`enforce`). Set `mode: shadow` to see proposals while keeping every task.

## Quick start

This two-job example selects an existing Go unit-test job. Add `JEV_API_KEY` as a repository secret and authorize sending the diff and task metadata to the provider. No additional files or scripts are required.

```yaml
name: CI
on:
  pull_request:
  push:
permissions:
  contents: read
jobs:
  selection:
    runs-on: ubuntu-latest
    outputs:
      unit: ${{ steps.select.outputs.unit }}
      tested-sha: ${{ steps.select.outputs.tested-sha }}
    steps:
      - uses: guilhem/jev-ci-selector@v0.1.0
        id: select
        with:
          api-key: ${{ secrets.JEV_API_KEY }}
          allow-external-context: 'true'
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
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: ${{ needs.selection.outputs.tested-sha }}
          persist-credentials: false
      - uses: actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5
        with:
          go-version-file: go.mod
      - run: go test ./...
```

`v0.1.0` is the initial release reference. Use the released commit SHA for immutable pinning.

Keep the selection job isolated from project scripts and dependency installation. Keep it required if branch protection relies on this minimal workflow: a skipped test job alone does not prove selection succeeded. For an existing final CI gate, preserve its checks; [advanced static jobs](examples/static-jobs/README.md) demonstrate handling failed planning and skipped selected jobs.

## Runner prerequisites

GitHub-hosted runners support the Node.js 24 runtime used by this action.
Self-hosted runners must be version 2.328.0 or newer. macOS 13.4 and older
self-hosted runners and ARM32 runners are not supported by the Node.js 24
runtime.

## Define precise tasks

Every task is an object with a required description. Explain what it verifies and which inputs affect it; a valid schema cannot make a vague description precise.

```yaml
with:
  tasks: |
    integration:
      description: Verifies HTTP authentication and PostgreSQL persistence.
      jobs:
        - workflow: .github/workflows/ci.yml
          job: integration
      context_files: [tests/integration/setup.ts]
      resolve_context_files: true
      force_paths: [migrations/**]
    lint:
      description: Verifies TypeScript ESLint rules.
      always: true
```

Job references and context files are optional enrichment. Explicit `context_files` are always retained; `resolve_context_files: false` disables only additional context discovery, while job evidence remains available. Discovery is experimental and opt-in: the default is `false`; set `resolve_context_files: true` to enable it. Context preparation reads trusted Git metadata and tracked files without executing repository code. It uses two preparation passes over all tracked paths, with no lexical or language filter, then evaluates the diff.

If preparation is incomplete, affected tasks run and the report records `context-resolution-incomplete` with status `fallback`. Independently evaluated tasks may still skip. An incomplete final observation retains the existing full-CI fallback. Forks, missing credentials or consent, and events outside PR evaluation retain all tasks without a Jev call.

When opting into discovery, consider `timeout-ms: '60000'` for the shared preparation and evaluation budget. The input default remains 10 seconds; larger trees can need a longer budget. Without opt-in, only job metadata and explicit context are used.

A `false` output is a policy decision, not a guarantee that the task cannot detect a regression. Changes to workflows retain all declared tasks. An invalid task definition fails selection without publishing a plan.

For precise descriptions and explicit context, use the [describe-ci-jobs skill](skills/describe-ci-jobs/SKILL.md). It follows the job's commands, tool configuration and local actions to describe its actual verification scope, independently of the current PR.

Jev classifies each change group against each task as `required`, `independent` or `unresolved`. Only `independent` in every group permits skipping; `required` and `unresolved` retain the task. Raw choices, distributions and confidence appear in report v7. There is no threshold to tune.

## Observe or customize

Add `mode: shadow` to keep all effective outputs true and read the proposed selection in the GitHub job summary. Reports and a standalone analyzer are optional [advanced observation tools](docs/shadow-mode.md).

```yaml
with:
  model: jev-1.13.0
  api-base-url: https://provider.example/jev
  api-model: provider-alias
```

A custom provider must implement Jev System One. `api-model` is the requested identifier; its response must identify the exact canonical `model`. These are common inputs, never per-task settings.

## Reference and examples

- [Complete input, task, output and report contract](docs/reference.md)
- [Existing static jobs and prerequisites](examples/static-jobs/README.md)
- [Independent task matrix](examples/matrix/README.md)
- [Independent shadow observer](examples/shadow/README.md)
- [Moving from paths-filter](docs/paths-filter.md)
- [Trust boundaries and external data](SECURITY.md)
- [Task schema](schemas/tasks.schema.json) and [report schema](schemas/report.schema.json)

## Development

Use Node.js 24 and Git:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm run eval:replay
```

Tests use temporary Git repositories, mocked HTTP and the shipped bundles. Replay verifies the committed synthetic evaluation recordings without a key or network. [Evaluation details](docs/evaluation.md).

Commit regenerated bundles with their sources. `npm run check:dist` checks reproducibility. The action and standalone analyzer include their dependency license notices.

This API is a breaking update: existing integrations must supply inline `tasks`; explicitly set `mode: shadow` to retain observation-only behavior. The current analyzer accepts report v7 only.
