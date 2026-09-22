# Moving from paths-filter

Keep your existing jobs, dependencies and output conditions. Replace the filter step with a semantic task definition and forward each named output as before:

```yaml
- uses: guilhem/jev-ci-selector@v0.1.0
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

See the [complete contract](reference.md) and [minimal integration](../README.md#quick-start). Release references in examples are publication targets, not claims of an already available tag.
