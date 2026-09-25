# Independent tasks in a matrix

Use the [describe-ci-jobs skill](../../skills/describe-ci-jobs/SKILL.md) to inspect your jobs, then copy and adapt the [workflow](.github/workflows/ci.yml), including its inline descriptions. The skill runs during authoring, never in CI. Provide your normal tool setup and e2e scripts. Each matrix entry must prepare its own prerequisites: the `build` entry does not provide ordering or artifacts to other entries. For real inter-job dependencies use the [static example](../static-jobs/README.md).

The selector applies exclusions by default. Add `mode: shadow` explicitly for observation. Sending the diff and descriptions requires the shown consent and `JEV_API_KEY`. It uses moving `@main` after this change is merged; pin the resulting commit SHA for reproducible CI. No new release tag is assumed.

The `has-tasks` condition is evaluated before matrix expansion. An empty selection skips the matrix and can pass the final gate only after successful planning. Nonempty selections require matrix success. The launcher accepts only fixed known task IDs and never evaluates model-generated shell code.

Keep inline tasks, launcher cases and expected task IDs synchronized. The final `ci-required` job checks aggregate output shape, event SHA, selected matrix results and full bypass/fallback plans. Make it required for this template. Every task checks out `tested-sha`.

No extra validation job or consumer script is required. This repository's integration tests check template consistency and final-gate failure cases. Artifact upload is optional evidence and is the only soft-failing step; artifacts include the run and attempt in their name and expire after 14 days.

[Complete contract](../../docs/reference.md) · [Minimal two-job integration](../../README.md#quick-start)
