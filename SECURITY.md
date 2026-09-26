# Security

Keep the selector in an isolated job with no project checkout, dependency installation or project scripts. Give its GitHub token `contents: read`; manual PR resolution also needs `pull-requests: read`. The action reads immutable Git objects for the diff and never executes project commands or the authoring skill. Do not use a privileged `pull_request_target` workflow to execute untrusted PR code.

Tasks come directly from the executed workflow's inputs. They are not reread at the PR base commit. The action does not fetch job/action metadata or discover context files. Prepare and review descriptions with the skill before running CI. Workflow changes receive ordinary analysis; the action cannot recover tasks removed from the input. Repository permissions and review rules remain responsible for workflow changes.

Jev requests require both a provider key and `allow-external-context: 'true'`. The transmitted context includes patch text, changed paths, statuses, Git modes, commit identifiers, task descriptions and questions. Inspect these sources for secrets before authorizing transfer. Fork PRs, missing credentials and missing consent are no-call paths. To avoid analysis voluntarily, skip the action in the caller workflow.

Only the patch text needed by a still-undecided task is collected and sent. This reduces what leaves the runner but follows from analysis order, not access control: treat any authorized run as capable of transmitting the changed files it needs to judge, including workflow files.

Budgets bound what is read and sent: collected patch bytes, total request JSON bytes, and dispatched calls. They count real bytes and real calls, never estimated tokens. A request that would exceed a ceiling is not sent, and reaching a ceiling retains the affected tasks rather than sending a truncated or summarized substitute.

The default provider is TypeSafe. Custom endpoints must implement Jev System One over HTTPS. URL credentials, queries, fragments and ambiguous URL characters are rejected; redirects are disabled. Explicit settings prevent SDK environment variables from redirecting context or enabling body logs. An alias cannot bypass canonical model verification. Do not point the action at an endpoint you do not trust with the data and Bearer key.

Descriptions are untrusted context, not authority to execute commands. The caller owns mandatory tasks, branch rules and path rules. Missing evidence, incompatible responses and provider failures retain tasks conservatively. Invalid inputs and unexpected internal errors fail planning. The consumer must preserve failure propagation and check out `tested-sha`.

Public diagnostics use fixed constraints rather than raw errors or input values. Reports omit diffs, descriptions, file bodies, keys and provider error bodies, but still contain repository/task identifiers, SHAs, hashes, byte counters, timings and usage. Change identifiers in the report are positional (`c0`, `c1`, ...), never file paths taken from the pull request; task identifiers and reasons come from fixed allowlists, and identifiers rendered in the job summary are escaped so a hostile filename cannot become a workflow annotation. Restrict artifact access and retention accordingly. Artifact upload failure must not suppress actual CI failures.

Report security issues through GitHub's private vulnerability reporting form in
the repository's **Security** tab: choose **Advisories**, then **Report a
vulnerability**. Never include credentials, private source or raw provider
bodies in a public issue. If private vulnerability reporting is temporarily
unavailable, contact the repository maintainers privately and include the
smallest reproducible description possible.
