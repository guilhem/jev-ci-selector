# Evaluate task selection

The qualification corpus uses generic synthetic examples authored for this
repository. Its diffs, workflows, action definitions, scripts and configuration
are self-contained. No external project checkout is needed.

The [corpus manifest](../tests/evaluation/corpus.json) is the source of truth for
case inputs, provenance and relevance annotations. The
[corpus guide](../tests/evaluation/README.md) describes the runner, recorded
campaigns and supported options.

## Run the corpus

From the repository root:

```sh
npm run eval:replay
```

Replay checks two committed live Choice regressions without a network connection
or API key. It checks that each response belongs to the complete recorded request. Changes to the
context or questions make the affected recordings explicitly stale.

Use `npm run eval:live` explicitly to record a new campaign with the configured
Jev API. Follow the corpus guide for credentials, output directories and campaign
comparisons. Live execution does not replace the committed reference recordings.
No credentials or authorization headers belong in the recordings.

## Interpret the results

Relevance annotations are separate from Jev responses. A disagreement remains a
qualification result; it must not be rewritten as an expected answer. Simulated
responses used to exercise software error handling are identified separately from
live API observations.

Compare results only for matching corpus inputs and trial settings. A campaign
from different examples cannot qualify the synthetic corpus. Context changes
require new measurements before selecting a context strategy or drawing a conclusion.

Reports separate proposed selection from effective policy outputs. Shadow mode
keeps every task. Synthetic relevance results do not demonstrate runtime savings
or accuracy on a consuming repository; that needs its own shadow observations and
actual CI outcomes. See the [shadow guide](shadow-mode.md).

Current campaigns use Choice only and compare context and grouping variants.
The archived Noul campaigns and their calibration thresholds are historical
results, not qualification of the current action. The current runner rejects
those campaigns; its default replay checks the frozen Choice evidence instead.
