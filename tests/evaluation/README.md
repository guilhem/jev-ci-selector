# Offline description-only evaluation

Run `npm run eval:replay`. It needs no API key or network access.

`selection.json` is a synthetic set of task descriptions prepared in advance. The eight generic cases in `corpus.json` keep self-authored diffs, base files, provenance, and code-inspection relevance annotations. Replay validates each diff against its base, checks task coverage, and checks that the Jev Choice question contains only `{description}` for each task. It does not ask Jev to interpret the diffs.

`recordings/mock-choice.json` contains explicit deterministic mock choices. Replay checks the production selection policy: only an `independent` choice with complete coverage permits a skip; `required`, `unresolved`, absent choices, incomplete coverage, and protected paths retain tasks. These mocks are technical contract checks, not provider responses or accuracy measurements.

The old enriched/context campaigns and their provider recordings were removed because their requests are incompatible with the description-only contract. Do not compare mock results with those historical campaigns. A future live evaluation needs newly collected provider evidence under this contract.
