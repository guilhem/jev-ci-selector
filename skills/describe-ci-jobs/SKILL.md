---
name: describe-ci-jobs
description: Write or refresh jev-ci-selector task descriptions from inspected GitHub Actions jobs, so Jev can judge changes against their actual verification scope.
---

# Describe CI jobs

Use this skill before CI selection to write the inline `tasks` consumed by `jev-ci-selector`. The skill is never run in CI. Jev judges each change group from its diff and the task description alone, using the criteria in `src/jev.ts`: `required` when the change touches behavior checked, artifact inputs, tests, or verification tools/configuration the task consumes; `independent` only when the described scope establishes that the change is outside all of these; `unresolved` otherwise. Do the repository reading first and write every relationship Jev needs into the text, in terms a changed path or diff can be matched to. Describe the job at the revision whose checks will run; note a scope difference when evaluating older changes.

## Inspect the whole job

- Read every executed step, condition, matrix, service, `needs`, artifact and local action metadata. Follow each command through package scripts and repository scripts into the configurations they load. A later build or preparation of another surface is part of the job too.
- For each phase, follow entry points to the code they consume: explicit imports, framework-discovered entries and startup hooks such as instrumentation. Trace consumers as well as producers: generated types, contracts or schemas produced elsewhere can still be inputs here.
- Delimit each test suite with its command and selected config, `testDir`, projects or filters. Sharing a test tool or installation does not establish that two suites run the same tests.
- Identify the packages each phase actually executes or imports: the runner and its plugins for a test job; the framework, compiler and runtime libraries imported by the built code for a build. For external actions, state only what inspected metadata or supplied inputs support.

## Write the task

Write one task per coherent verification scope, in a few paragraphs of prose. Lead with the software behavior the job ships or checks and its stack, then cover what the criteria ask about:

- **Artifact inputs.** Name consumed modules by responsibility with a path landmark precise enough to match a changed file ("article permission rules in `src/lib/server/policy`" rather than "`lib/`" or "shared code"), including what each startup hook loads. Say that their behavior, types and signatures become part of the artifact: a build's scope is what it ships, beyond whether it compiles.
- **Checked behavior and tests.** Each suite's command, selection and what it asserts.
- **Tools and packages.** Name the specific packages from inspection; a change to their version or configuration changes this job's input. Do not present the lockfile or shared install as an input by itself, and omit current version numbers, which the diff already shows.
- **Overlap with other jobs.** Where another job's suite tests production code this job consumes, say that its boundary excludes those test files, while the production code remains an input here. Exclude their runner only if this job neither executes nor imports it; otherwise the runner remains an input here. Say when a tool is installed or run only elsewhere.
- **Unknowns and proven exclusions.** Mark unverified relationships as unknown; state an exclusion only when inspected commands and suite boundaries prove it.

Keep operational detail such as deployment branches, environment flags or runner images only where it changes an input, output or verification boundary. Paths and commands are landmarks, never an exhaustive list or path allowlist. Do not add patch-specific hints, predict failures or tell Jev which judgment to make. This fictional example illustrates the shape; replace every fact with inspected evidence:

> Builds the SvelteKit knowledge-base application for editing, previewing and searching articles. Route entries consume the editor and search UI in `src/lib/ui`, Markdown parsing and rendering in `src/lib/content` and article permission rules in `src/lib/server/policy`; their behavior, types and signatures become part of the browser and server bundles. The server startup hook loads request logging from `src/lib/server/log`. Generated API types in `src/lib/client` are compilation inputs through those routes. SvelteKit, Vite, TypeScript and the runtime libraries these modules import are build inputs. Playwright runs `e2e/wiki` against the built application. Vitest suites under `tests/` run in another job: that boundary excludes those test files and Vitest itself, and the production code they exercise is still bundled here. External search-service behavior was not verified.

Before finishing, read each description as Jev would, with only a diff in hand. Take a few realistic change kinds from the repository tree: a consumed production module whose tests live in another job, a startup or configuration file, a version bump of a tool only another job runs, a library the built code imports, and a file from an unrelated surface. Each should land on a sentence that supports the right outcome. When a consumed change matches only a broad label or nothing, or an unrelated change matches a blanket claim, rewrite that relationship.

Preserve existing task IDs, `always`, `force_paths`, and the requested task scope. A description does not replace workflow steps, conditions or `needs`. Put the relevant evidence in each description; `jobs`, `context_files` and `resolve_context_files` are unsupported task keys. Descriptions cost request space, so keep them concise without dropping a causal link.

Validate the YAML against the [task schema](../../schemas/tasks.schema.json) when available and confirm referenced jobs, scripts and paths at the described revision. If live trials are authorized, compare the task against independently assessed relevant, unrelated and uncertain changes; report actual judgments and limits, then revise only from observed evidence. Refresh descriptions when the job's commands, configuration or verification boundary changes.
