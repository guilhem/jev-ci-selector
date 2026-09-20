# Security

Keep the selector in an isolated job with no project checkout, dependency installation or project scripts. Give its GitHub token `contents: read`; manual PR resolution also needs `pull-requests: read`. The action reads immutable Git objects and never executes the commands it inspects. Do not use a privileged `pull_request_target` workflow to execute untrusted PR code.

Tasks come directly from the executed workflow's inputs. They are not reread at the PR base commit. Metadata references are read at immutable revisions: the PR base for automatic analysis, or the operator-selected workflow revision for manual analysis. Workflow changes impose execution of all declared tasks, but the action cannot recover tasks removed from the input. Repository permissions and review rules remain responsible for workflow changes.

Jev requests require both a provider key and `allow-external-context: 'true'`. The transmitted context includes the diff, changed paths, commit identifiers, task descriptions, questions and requested workflow/file metadata. Inspect these sources for secrets before authorizing transfer. Fork PRs, missing credentials, missing consent and explicit full execution are no-call paths.

The default provider is TypeSafe. Custom endpoints must implement Jev System One over HTTPS. URL credentials, queries, fragments and ambiguous URL characters are rejected; redirects are disabled. Explicit settings prevent SDK environment variables from redirecting context or enabling body logs. An alias cannot bypass canonical model verification. Do not point the action at an endpoint you do not trust with the data and Bearer key.

Descriptions are untrusted context, not authority to execute commands. Required tasks and path rules take precedence over model decisions. Missing evidence, incompatible responses and provider failures retain tasks conservatively. Invalid inputs and unexpected internal errors fail planning. The consumer must preserve failure propagation and check out `tested-sha`.

Public diagnostics use fixed constraints rather than raw errors or input values. Reports omit diffs, descriptions, file bodies, keys and provider error bodies, but still contain repository/task identifiers, SHAs, hashes, timings and usage. Restrict artifact access and retention accordingly. Artifact upload failure must not suppress actual CI failures.

Report security issues through GitHub's private vulnerability reporting form in
the repository's **Security** tab: choose **Advisories**, then **Report a
vulnerability**. Never include credentials, private source or raw provider
bodies in a public issue. If private vulnerability reporting is temporarily
unavailable, contact the repository maintainers privately and include the
smallest reproducible description possible.
