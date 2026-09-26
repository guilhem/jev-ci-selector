# Independent shadow observer

Before copying the [observer workflow](.github/workflows/observe.yml), use the [describe-ci-jobs skill](../../skills/describe-ci-jobs/SKILL.md) to inspect your jobs and adapt the inline `build` and `unit` descriptions. The skill runs during authoring, never in CI. Each task requires a description; `jobs`, `context_files` and `resolve_context_files` are rejected.

This optional workflow observes the normal selection without wiring its outputs into any CI job. It does not check out code, execute project commands, expose job outputs or control CI jobs. Do not make it a required check. Its `contents: read` permission is sufficient for automatic PR observation.

Authorize sending the diff and saved descriptions with `allow-external-context: 'true'` and configure `JEV_API_KEY`. Forks or absent consent/credentials retain all tasks without calling Jev. `tested-ref: merge` is the default. Match `head` explicitly only if your real CI tests the head.

The workflow uses moving `@main` after this change is merged. Pin the resulting commit SHA for reproducible CI; no new release tag is assumed.

The summary provides the observation directly. Optional artifacts use `jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}`, 14-day retention, and a soft-failing upload. For matched CI results, manual `results.json` and the matching standalone analyzer, follow the [shadow guide](../../docs/shadow-mode.md). The analyzer does not automatically match workflow attempts or collect CI job results.
