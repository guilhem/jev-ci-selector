# Existing jobs with prerequisites

Copy and adapt the [workflow](.github/workflows/ci.yml). Task definitions are inline in its selector step; no other file or script is needed. Supply your normal Go/Helm setup and the consumer-owned e2e scripts before enabling it.

The example applies selection by default. Set `mode: shadow` explicitly to observe. Its external-context opt-in authorizes transmission when `JEV_API_KEY` exists. The `v0.1.0` reference is the intended release target; use a published commit SHA for immutable pinning.

The planning job executes no project code. Every task checks out `tested-sha`. The network and upgrade jobs retain `needs: [plan, build]`; `build` stays mandatory so it is available whenever either dependent task is selected. Descriptions and metadata references do not create dependency ordering.

The final `ci-required` job runs even after failures, validates the plan and named output consistency, verifies the tested SHA, and requires every selected job to succeed. Make it required if using this complete template. Keep task IDs, forwarded outputs, jobs and the final gate's expected sets synchronized when adapting it.

PRs may be selected; push, schedule and merge groups execute every task without Jev. Failed planning cannot become a successful final gate. The report artifact is optional evidence: its upload alone uses `continue-on-error: true`, with 14-day retention and run/attempt-specific naming.

Repository integration tests exercise malformed plans, failed planning, selected skipped/failed jobs, prerequisite failures, output divergence and SHA mismatches. Consumers retain their own CI gate tests when adapting these checks.

[Complete contract](../../docs/reference.md) · [Simpler quick start](../../README.md#quick-start)
