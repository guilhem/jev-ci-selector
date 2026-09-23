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

**What replay does and does not qualify.** Replay exercises the whole-diff path:
a diff that is already built, effectively unlimited ceilings, and a question for
every task on every group. It therefore verifies that the recorded request
contract is preserved. It does **not** exercise the progressive path the action
actually uses — demand-driven unit collection, budgets, per-task coverage and
early stopping — so "0 stale recordings" means the historical contract is intact,
never that the new grouping has been validated against the recorded judgments.

Qualifying the progressive path needs its own campaign, over cases the current
corpus does not contain: changes spread across several collection units, and
interdependent changes deliberately placed on either side of a unit boundary.
Until that campaign has run, the unit and integration tests cover the scheduler's
mechanics only. Mechanics are not judgment quality: simulated responses show that
the software behaves as specified, never that Jev decides well.

## Question wording, measured live

Context preparation used to repeat the judgment, scope and all three criteria in
every per-path question. It now states that wording once in the state and leaves
each question with its path and a reference.

A live campaign on the labelled corpus compared the two, three cases over one,
two and three passes:

| | recall | incorrect skips | input tokens |
| --- | ---: | ---: | ---: |
| repeated in every question | 3 / 6 / 7 | 0 | 65 282 |
| stated once in the state | **4 / 7 / 7** | 0 | **57 790** |

Recall better or equal at every pass count, no incorrect skips either way, 11%
fewer input tokens. Synthetic scaling over a larger repository puts the saving
at roughly half the calls and bytes at 20 000 tracked files — not the five-fold
the question bytes alone suggest, because the path and the JSON envelope remain.

On that evidence the shared form is simply how it works; there is no option.

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
Grouping changes count as context changes: a judgment recorded against one
grouping does not transfer to another.

Reports separate proposed selection from effective policy outputs. Shadow mode
keeps every task. Synthetic relevance results do not demonstrate runtime savings
or accuracy on a consuming repository; that needs its own shadow observations and
actual CI outcomes. See the [shadow guide](shadow-mode.md).

Current campaigns use Choice only and compare context and grouping variants.
The archived Noul campaigns and their calibration thresholds are historical
results, not qualification of the current action. The current runner rejects
those campaigns; its default replay checks the frozen Choice evidence instead.

## Coarse inventory pass

Before any patch is read, one question per still-open task is asked over the
manifest's paths, statuses and modes — no file content at all. A task the paths
already implicate is settled there and never reaches the content pass.

Its question has exactly two options, `required` and `undetermined`. That is the
design, not an omission: with no `independent` option the shortcut the pass must
never take cannot be expressed at all, so it is structurally incapable of
producing a wrong exclusion — it can only move a task to "must run". A third
`unresolved` option would also lose skips the content pass finds today, since an
opaque list of a thousand paths would resolve to it and retain everything.

Two consequences follow, and both are asserted in `tests/unit/inventory.test.ts`:
the pass never grants coverage, so an exclusion still requires the content sweep;
and a failed coarse call never retains anything, which inverts the usual rule
because an uninformative pass must leave every task exactly where it was.

What it buys is calls, not correctness: a task the inventory already settles
stops appearing in later requests, so a large change set that must run anyway is
decided in one call instead of reading all of it. It does **not** help prove a
task independent of a large change set — that requires reading everything, and
is irreducible.

Measured live. On the labelled corpus — built around *indirect* links, where a
path cannot be conclusive — it settled nothing and wrongly forced nothing, which
is the correct abstention. On paths that are conclusive on their own
(`tests/e2e/checkout.spec.ts` against an end-to-end task, `.eslintrc.json`
against a lint task, an ordinary source file against both) it settled 2 of 2
correctly and forced none wrongly.

So it is precise rather than eager: it settles when the paths are conclusive and
abstains otherwise. It costs one call of roughly 900 input tokens per run, which
buys skipping the entire content sweep for every task it settles — on a large
change set, up to hundreds of calls. It is on by default.

It is still `shadow` that keeps observing every task, so the coarse pass does not
run there.
