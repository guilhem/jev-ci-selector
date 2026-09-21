# Evaluation runner

All eight scenarios and every snapshot file were authored from scratch for this
public repository. They are synthetic fixtures, not extracts or anonymizations
of a real application. The external action descriptor is fictional. The base/head
hashes identify locally generated fixture commits, not an external repository.

The runner uses the committed corpus under this directory and the trusted local
snapshot named by each case. It never checks out a repository, runs a source
script, reads `.env`, or sends credentials in a replay.

The corpus has this shape:

```json
{
  "version": 1,
  "cases": [{
    "id": "case-id",
    "split": "calibration",
    "diff": "cases/case-id/diff.patch",
    "baseFiles": "cases/case-id/base",
    "snapshot": "snapshots/generic-app",
    "expected": {"unit": {"relevance": "relevant", "reason": "..."}},
    "provenance": {"base": "...", "head": "...", "metadataCommit": "..."}
  }]
}
```

Each snapshot contains `repository/`, `external-actions.json`, and
`action-inputs.json`. The latter stores raw action input strings: `tasks` as YAML,
`model`, and `skip-below`. The repository contains referenced workflows, action
metadata, package manifests, and context files. The runner uses the production
`parseSelectionInputs` and `resolveTasks` functions; it does not execute files.
Expected relevance labels are annotations made by code inspection before Jev
evaluation. They are qualification data for this experiment, not independent
human validation or evidence of test outcomes.

Replay is offline and uses the exact request bodies captured from the SDK:

```sh
npm run eval:replay -- --campaign tests/evaluation/recordings/<campaign>
```

With no `--campaign`, replay requires and checks both committed baselines at
`tests/evaluation/recordings/calibration` and
`tests/evaluation/recordings/validation`. Pass `--campaign <path>` to check one
campaign explicitly. Replay matches the serialized SDK body and its SHA-256
before returning the stored structured response. A changed corpus, source
fingerprint, request, response, or derived observation fails explicitly as a
stale replay. Measured durations are ignored only in the final deterministic
comparison.

The inline-input migration changed fixture fingerprints and removed obsolete
null task probability fields from derived policy results. It did not rerun the
provider. `recordings/migration-proof.json` contains SHA-256 digests of each
campaign's original calls (including serialized bodies and responses), complete
observations, SDK/model metadata, and dates. The integration test checks these
digests as well as replaying every request through the current production code.
The replay source, request, and output equality guards remain strict.

Live evaluation requires an explicit API key in `JEV_API_KEY`, `JEV_KEY_API`, or
`TYPESAFE_API_KEY`; it does not load `.env`. Calibration evaluates description
and enriched context, single and split questions, natural and 8 KiB partitioned
grouping, and three repeats. Natural grouping uses a 48 KiB target; large diffs
may still produce several actual groups. Use `--case id` for a smoke run.

```sh
npm run eval:live -- --split calibration --output /tmp/jev-calibration
npm run eval:live -- --split validation --selection /tmp/jev-calibration/selection.json --output /tmp/jev-validation
```

Live output must be a new directory. When the committed
`tests/evaluation/recordings/<split>` baseline exists, `eval:live` compares the
new campaign with it; use `--baseline <campaign>` to select another previous
campaign explicitly. The baseline is read-only and is never replaced. Each
live output contains `manifest.json`, `summary.json`, `comparison.json`,
`selection.json` for calibration, and one structured JSON record per run under
`runs/`. `comparison.json` reports relevant misses, useful omissions, repeat and
partition stability, token totals, latency deltas, and a comparable-settings
guard. Incompatible corpus, case, variant, repeat, threshold, SDK, or frozen
validation-selection settings leave deltas null and explain the guard reason.
Partial observations and sanitized error codes are persisted. Records
contain no HTTP headers, credentials, or private provider error bodies. The
selection maximizes correctly omitted irrelevant tasks while requiring zero
relevant misses across all calibration repeats and groupings; ties use the
lowest threshold and stable context/question ordering. If no variant qualifies,
the best exploratory choice is recorded with `qualified: false`.

## Context-resolution comparison

`eval:context` is a separate bounded harness for the accepted context
resolution feature. It uses three manually authored synthetic cases: Python
wrapper to TOML scope, Go wrapper to YAML scope, and a generic Node wrapper to
JSON scope. Each case includes an unrelated documentation task. These are
experiment annotations, not real pull requests, and no case source is
executed.

The harness runs one, two, and three preparation waves on a fresh selection for
each case, then uses the existing `observeChange` Noul evaluator on the same
annotated diff. Offline mode supplies deterministic evaluators; live mode calls
the Jev API. Results report file recall and final incorrect skips, with no model
score or CI savings metric.

Offline probabilities are fixture-wiring signals only: they verify that context
availability reaches the existing final evaluator and are never a measurement
of model quality.

Each run requires a new output directory and writes `manifest.json`,
`summary.json`, `comparison.json`, and sanitized records under `records/`.
Records contain deterministic request hashes, decisions, stage reports, usage,
timings, and completeness. They do not contain headers, API keys, or raw source
text. A failed or unavailable stage is marked `incomplete` and is not counted
as a successful evaluation.

```sh
npm run eval:context -- offline --output /tmp/jev-context-offline
npm run eval:context -- live --output /tmp/jev-context-live
```

Live mode reads only `JEV_API_KEY`, `JEV_KEY_API`, or `TYPESAFE_API_KEY`; it does
not load `.env`. Load a dotenv file explicitly with Node's `--env-file` if
needed. Optional `--api-base-url` and `--api-model` follow the existing runner.
