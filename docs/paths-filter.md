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
      frontend:
        description: Verifies React rendering, navigation and browser interactions.
```

Use `steps.changes.outputs.backend == 'true'`, or expose that value as a job output. Check out `tested-sha` in consumers and retain the existing workflow's failure handling.

Descriptions explain verification scope; this is not pattern-language compatibility. Keep any mandatory path rules in your workflow. The action has no positive/negative filter rules or changed-file-list outputs. Valid PR and push ranges go through analysis; events without usable refs retain tasks conservatively.

For an observational comparison, run the selector independently alongside full CI without consuming its outputs. Keep essential tasks unconditional in the caller and prerequisites in `needs`. The removed `mode`, `force-all`, `always` and `force_paths` options are rejected.

See the [complete contract](reference.md) and [minimal integration](../README.md#quick-start). This example applies after the description-only change reaches `main`; pin the resulting commit SHA for reproducible CI.
