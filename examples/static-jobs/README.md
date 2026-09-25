# Existing jobs with prerequisites

Use the [describe-ci-jobs skill](../../skills/describe-ci-jobs/SKILL.md) to inspect your jobs before copying and adapting the [workflow](.github/workflows/ci.yml). Paste the resulting descriptions into its inline tasks. The skill runs during authoring, never in CI. Supply your normal Go/Helm setup and the consumer-owned e2e scripts before enabling it.

The example applies selection by default. Set `mode: shadow` explicitly to observe. Its external-context opt-in authorizes sending the diff and descriptions when `JEV_API_KEY` exists. It uses moving `@main` after this change is merged; pin the resulting commit SHA for reproducible CI. No new release tag is assumed.

The planning job executes no project code. Every task checks out `tested-sha`. The network and upgrade jobs retain `needs: [plan, build]`; `build` stays mandatory so it is available whenever either dependent task is selected. Descriptions do not create dependency ordering.

The final `ci-required` job runs even after failures, validates the plan and named output consistency, verifies the tested SHA, and requires every selected job to succeed. Make it required if using this complete template. Keep task IDs, forwarded outputs, jobs and the final gate's expected sets synchronized when adapting it.

PRs may be selected; push, schedule and merge groups execute every task without Jev. Failed planning cannot become a successful final gate. The report artifact is optional evidence: its upload alone uses `continue-on-error: true`, with 14-day retention and run/attempt-specific naming.

Repository integration tests exercise malformed plans, failed planning, selected skipped/failed jobs, prerequisite failures, output divergence and SHA mismatches. Consumers retain their own CI gate tests when adapting these checks.

[Complete contract](../../docs/reference.md) · [Simpler quick start](../../README.md#quick-start)
