---
name: describe-ci-jobs
description: Describe GitHub Actions jobs as precise Jev verification tasks, using inspected workflow commands, invoked tooling, action metadata, inputs, artifacts, and explicit context files.
---

# Describe CI jobs

Use this skill when turning existing GitHub Actions jobs into the inline `tasks` YAML consumed by `jev-ci-selector`.

Inspect the real workflow and job before writing a task:

- Read the job's `run` commands, `uses` steps, conditions, matrices, outputs, artifacts, and dependencies that affect what it verifies.
- Follow each invoked repository script or command to its implementation and read the tool configuration it uses. Include the actual checks, scopes, filters, generated inputs, and artifact or report validation, rather than naming only the headline tool.
- Read local action metadata (`action.yml`, `action.yaml`, or an action directory's metadata) for every local action the job invokes. Record the inputs the job supplies and the inputs the action declares or consumes.
- Inspect relevant package or dependency manifests and distinguish dependencies that are installed from dependencies that the job actually executes or loads.
- Identify the repository paths whose contents can change the job's result: workflow and action metadata, invoked scripts, tool configuration, fixtures or schemas, artifact producers and consumers, and setup files. Use paths found during inspection; do not invent names.
- Describe the job's actual verification boundary. A passing execution alone does not prove that a change is independent of the job; inspect its inputs and consumers.

Write one task per coherent verification scope. Make `description` concrete: name the behavior or contract checked, the commands or supported checks that implement it, and material inputs or boundaries. A description such as “runs actionlint” is insufficient when the job also validates a referenced local `action.yml` input; state the supported checks evidenced by the workflow, tool configuration, and action metadata. Do not add patch-specific hints or predict which future files will change.

Use `jobs` to anchor the task to the exact inspected workflow and job. Use `context_files` for the explicit paths needed to understand that verification scope, including relevant local action metadata and tool or artifact configuration. Omit `resolve_context_files` unless the user explicitly asks for discovery; its default is `false`.

Return a YAML mapping accepted by the action's [task schema](../../schemas/tasks.schema.json):

```yaml
task_id:
  description: Verifies the repository contract using the commands and inputs exercised by the inspected job.
  jobs:
    - workflow: .github/workflows/ci.yml
      job: validate
  context_files:
    - action.yml
    - package.json
    - scripts/build.mjs
```

Replace every example path and job with names verified in the target repository. Keep task IDs safe and unique, descriptions nonblank, job references relative and exact, and context files repository-relative, unique, and free of `..`, absolute paths, or NUL characters. Do not add unsupported fields, aliases, duplicate keys, or `resolve_context_files: true` by habit.

Before returning, parse the YAML and validate it against the action's schema when available. A consumer repository need not contain that schema; report if schema validation was unavailable. Confirm named workflows, jobs, scripts, configuration and artifact paths against the repository, and tool checks against its implementation or official documentation. The task describes verification scope; it does not create workflow dependencies or change what the job runs.
