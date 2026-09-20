# Security

The planner treats pull request content as untrusted data. Keep its job separate from any checkout, dependency installation, or execution of PR code. CI commands belong in consumer jobs.

## Keep planning isolated

- Use `pull_request` for automatic planning. Do not use `pull_request_target` to work around unavailable secrets. Fork PRs keep every task and never contact the configured Jev API.
- Pin the action to a reviewed full commit SHA containing `dist/index.js`. Limit the GitHub token to `contents: read`, adding `pull-requests: read` only for manual observation. Do not pass planner secrets to jobs that test PR code.
- Automatic events read the active catalog at the event's base SHA. Changes to the catalog or workflow files force all tasks; in shadow mode they may still receive model observations without affecting that policy.
- `workflow_dispatch` with `pull-request` evaluates a plan without executing jobs. The authorized operator selects the workflow revision and its catalog; this trusted `GITHUB_SHA` is recorded as `config_sha`. The target PR is resolved through the GitHub API and contributes Git data only. Use reviewed workflow revisions. The action never checks out or executes the target PR, and verifies merge parents or the head merge-base and fork status.
- Keep `ci-required` mandatory. A selected task that is skipped, cancelled, or unsuccessful must block validation. Maintain the catalog, jobs, `needs`, and contract checks together. Jobs executing PR code retain their own trust boundaries.

## Understand what leaves the runner

Set `allow-external-context: 'true'` only after approving the transfer of the diff, changed paths, commit SHAs, job definitions, referenced metadata/files, and task questions to the configured API (TypeSafe by default). Keep `api-base-url` and `api-model` under maintainer control; do not derive them from untrusted PR content. **Shadow mode sends this context too** when a key and permission are provided; it preserves all tasks, not the confidentiality of an authorized request.

Questions come from the trusted catalog, but the diff can contain adversarial content. This separation does not guarantee resistance to prompt injection. Jev can be wrong or influenced by the input, so keep essential checks under `always: true`. Shadow evaluates question-bearing mandatory tasks too; those answers do not override mandatory policy decisions. Explicit `force-all` disables inference as well as optimization.

Large diffs in both modes are split without dropping source, under fixed context-byte and request-count guards and one total deadline. Partial answers remain visible, but any failed or unstarted request retains full CI. Chunk answers are not a global assessment of interactions across the change. An omission in `enforce` requires complete below-threshold evidence for that job.

SDK logging is disabled. The default endpoint is `https://api.typesafe.ai`; an explicitly selected custom endpoint must use HTTPS, contain no URL credentials, query, or fragment, and provide the Jev System One contract. The SDK appends `/v1/systemone` after normalizing trailing slashes. The endpoint is selected only with explicit consent through `allow-external-context` and the corresponding Bearer `api-key`. Do not add logs containing request bodies, diffs, credentials, or raw errors. Public messages are fixed; reports contain validated metadata, hashes, probabilities, and deterministic reason codes.

Provider errors, redirects, rate limits, and model-version mismatches force full CI. The action does not automatically switch providers or paid models. The `api-model` input may select a provider alias, but the response must identify the catalog's canonical model version. Reports distinguish the requested identifier, expected canonical version, and returned version; historical reports without an expected version remain readable.

Reports still reveal task names, commit SHAs, and probabilities. Choose their visibility and retention according to your repository's policies, and never put secrets in catalog identifiers.

## Respond to a selection incident

Set `force-all: 'true'` or return to `mode: shadow`, then compare the report and actual task results for the same tested SHA and workflow run.

Merge-parent checks tie the diff to the event; they do not establish the semantic accuracy of a Jev response. This MVP does not guarantee detection of every regression. Measurement and an explicit decision to enable selective execution remain the maintainer's responsibility.

## Report a vulnerability

Report suspected vulnerabilities privately to the repository maintainer. This project does not publish a dedicated security contact yet; arrange a private channel before sharing sensitive details. Do not put credentials, confidential source code, or sensitive exploit details in a public issue.
