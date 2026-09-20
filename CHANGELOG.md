# Changelog

All notable changes to this project are documented here.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-21

### Added

- Inline `tasks` definitions with descriptions, job metadata, context files,
  mandatory tasks and positive `force_paths` rules.
- Deterministic task selection with conservative fallback behavior and optional
  Jev evaluation.
- Named task outputs plus aggregate `run`, `selected`, `matrix`, `has-tasks`,
  `status`, `tested-sha` and `report-path` outputs.
- Validated, source-free report version 5 with provenance, decision and
  observation details.
- Explicit shadow mode for observing proposed exclusions while retaining every
  effective CI task.

### Notes

- The default `skip-below` threshold is experimental and is a policy setting,
  not an accuracy guarantee.
- The action requires Node.js 24 support from the GitHub Actions runner.
