# Independent shadow observer

Copy the [observer workflow](.github/workflows/observe.yml) and adapt its inline `build` and `unit` descriptions/references to your existing CI. A description alone also works: remove `jobs` when enrichment is unnecessary.

This optional workflow explicitly sets `mode: shadow`. It does not check out code, execute project commands, expose job outputs or control CI jobs. Do not make it a required check. Its `contents: read` permission is sufficient for automatic PR observation.

Authorize context transfer with `allow-external-context: 'true'` and configure `JEV_API_KEY`. Forks or absent consent/credentials retain all tasks without calling Jev. Task inputs belong to the executed workflow; referenced metadata comes from the immutable PR base. `tested-ref: merge` is the default. Match `head` explicitly only if your real CI tests the head.

The `v0.1.0` reference is the intended release target, not proof of publication. Use the published release commit for immutable pinning.

The summary provides the observation directly. Optional artifacts use `jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}`, 14-day retention, and a soft-failing upload. For matched CI results, manual `results.json` and the standalone v5 analyzer, follow the [shadow guide](../../docs/shadow-mode.md). The analyzer does not automatically match workflow attempts or collect CI job results.
