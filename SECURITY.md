# Security

The planner treats pull request content as untrusted data. Keep its job separate from any checkout, dependency installation, or execution of pull request code. CI commands belong in consumer jobs.

## Keep planning isolated

- Use `pull_request` for automatic planning. Do not use `pull_request_target` to work around unavailable secrets. Fork pull requests keep every task and never contact the configured Jev API.
- Pin the action to the reviewed full commit SHA for the intended release, with `dist/index.js` present. The documentation examples use `guilhem/jev-ci-selector@v0.1.0` as a release target; that tag is not assumed to be published yet. Limit the GitHub token to `contents: read`, adding `pull-requests: read` only for manual observation.
- Do not pass planner secrets to jobs that test pull request code. The planning job must not check out the project, install dependencies, or execute project scripts.
- Automatic pull request events read the catalog from the event's base SHA. The tested commit is the merge commit supplied by the event when `tested-ref: merge` is used. Changes to the catalog or workflow files force every task.
- On non-pull-request events, the integrated examples invoke the action once; it reads the catalog at `github.sha`, makes no Jev call, and returns a full effective plan. An invalid catalog fails the planner instead of being replaced with an implicit plan.
- `workflow_dispatch` with `pull-request` evaluates an open PR without executing jobs. The authorized operator selects the workflow revision and catalog; that trusted `GITHUB_SHA` is recorded as `config_sha`. The target PR contributes Git data only. The action never checks out or executes the target PR and verifies merge parents or the head merge-base.
- Keep `ci-required` mandatory in integrated workflows. A selected task that is skipped, cancelled, or unsuccessful must block validation. Maintain the catalog, jobs, `needs`, and contract checks together. Jobs executing pull request code retain their own trust boundaries.

## Understand what leaves the runner

Set `allow-external-context: 'true'` only after approving the transfer of the diff, changed paths, commit SHAs, trusted job metadata, and task questions to the configured API (TypeSafe by default). Shadow mode sends this context too when a key and permission are provided; it preserves all tasks, not the confidentiality of an authorized request. Fork pull requests and missing keys are no-call paths.

Questions come from the trusted catalog, but the diff can contain adversarial content. This separation does not guarantee resistance to prompt injection. Jev can be wrong or influenced by the input, so keep essential checks under `always: true`. Shadow evaluates question-bearing mandatory tasks when an authorized call is possible; those answers do not override mandatory policy decisions. Explicit `force-all` disables inference as well as optimization.

Large diffs in both modes are split without dropping source, under fixed context-byte and request-count guards and one total deadline. Partial answers remain visible, but any failed or unstarted request retains full CI. Chunk answers are not a global assessment of interactions across the change. An omission in `enforce` requires complete below-threshold evidence for that job.

SDK logging is disabled. The default endpoint is `https://api.typesafe.ai`; an explicitly selected custom endpoint must use HTTPS, contain no URL credentials, query, or fragment, and provide the Jev System One contract. The SDK appends `/v1/systemone` after normalizing trailing slashes. The endpoint is selected only with explicit consent through `allow-external-context` and the corresponding Bearer `api-key`.

Keep `api-base-url` and `api-model` under maintainer control. Never derive either value from pull request content, the catalog edited by the pull request, or other untrusted input. Invalid API configuration fails before network access; the action does not automatically switch providers or paid models.

Public action messages use fixed error names and fixed constraint text. They never include input values, catalog contents, source text, credentials, provider error bodies, or raw exceptions. Reports contain only validated metadata, hashes, probabilities, timings, usage, and deterministic reason codes. Version 4 reports retain the names `config_sha`, `base_sha`, `head_sha`, `tested_sha`, `tested_ref`, `diff_base_sha`, `catalog_hash`, `job_metadata`, and `observation_error`.

Provider errors, redirects, rate limits, and model-version mismatches force full CI. The `api-model` input may select a provider alias, but the response must identify the catalog's canonical model version. Reports distinguish the requested identifier, expected canonical version, and returned version.

Reports reveal task names, commit SHAs, paths represented by trusted metadata, and probabilities. Choose their visibility and retention according to your repository's policies, and never put secrets in catalog identifiers.

## Respond to a selection incident

Set `force-all: 'true'` or return to `mode: shadow`, then compare the report and actual task results for the same tested SHA, workflow run, attempt, and task scope.

Merge-parent checks tie the diff to the event; they do not establish the semantic accuracy of a Jev response. This MVP does not guarantee detection of every regression. Measurement and an explicit decision to enable selective execution remain the maintainer's responsibility.

## Report a vulnerability

Report suspected vulnerabilities privately to the repository maintainer. This project does not publish a dedicated security contact yet; arrange a private channel before sharing sensitive details. Do not put credentials, confidential source code, or sensitive exploit details in a public issue.
