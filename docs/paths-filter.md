# Moving from paths-filter

Keep your existing jobs, dependencies and output conditions. Use the [describe-ci-jobs skill](../skills/describe-ci-jobs/SKILL.md) to inspect them and prepare descriptions before editing CI. Replace the filter step with those task definitions and forward each named output as before:

```yaml
- uses: guilhem/jev-ci-selector@main
  id: changes
  with:
    api-key: ${{ secrets.JEV_API_KEY }}
    allow-external-context: 'true'
    tasks: |
      backend:
        description: Verifies HTTP routes, authentication and database persistence.
        force_paths: [migrations/**]
      frontend:
        description: Verifies React rendering, navigation and browser interactions.
```

Use `steps.changes.outputs.backend == 'true'`, or expose that value as a job output. Check out `tested-sha` in consumers and retain the existing workflow's failure handling.

This is not pattern-language compatibility. Descriptions explain verification scope; positive `force_paths` globs only impose execution. A path that does not match can still be relevant. There are no negative filter rules, changed-file-list outputs or claim of identical event behavior. Events outside PR evaluation retain every task without calling Jev.

`enforce` is the default. For an observational comparison, explicitly set `mode: shadow`: effective outputs remain true and proposals appear in the job summary. Model judgments do not guarantee an error rate. Keep essential tasks under `always: true` and execution prerequisites in `needs`.

See the [complete contract](reference.md) and [minimal integration](../README.md#quick-start). This example applies after the description-only change reaches `main`; pin the resulting commit SHA for reproducible CI.
