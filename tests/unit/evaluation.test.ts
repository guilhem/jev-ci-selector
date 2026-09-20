import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { actionOutputs } from '../../src/report.js';
import { decisionsFromObservation } from '../../src/observations.js';
import { selectTasks } from '../../src/policy.js';
import { chooseSelection, createLiveTransport, createReplayTransport, corpusFingerprint, evaluateRecord, loadCase, readCorpus, replayCampaign, metricsForLabels, replayComparable, writeJson, type EvaluationRecord, type ReplayCall } from '../evaluation/evaluation.js';
import { compareCampaignData } from '../evaluation/comparison.js';
import type { ResolvedSelection } from '../../src/tasks.js';
import { evaluateJev, JevError } from '../../src/jev.js';

test('replay transport rejects stale serialized SDK bodies before returning a response', async () => {
  const serialized = '{"exact":true}';
  const calls: ReplayCall[] = [{ index: 0, request: { body: { exact: true }, serialized, sha256: createHash('sha256').update(serialized).digest('hex') },
    response: { status: 200, body: { ok: true } }, error: null, duration_ms: 1 }];
  const transport = createReplayTransport(calls);
  await assert.rejects(transport.fetch('https://api.test', { body: '{"exact":false}' }), /replay-request-mismatch/);
  assert.equal(transport.stale()?.name, 'ReplayStaleError');
  await assert.rejects(transport.fetch('https://api.test', { body: serialized }), /replay-request-mismatch/);
});

test('replay comparison strips replay-only call bookkeeping', () => {
  const record = { calls: [{ used: true, index: 0, request: { body: {}, serialized: '{}', sha256: 'hash' }, response: null, error: null, duration_ms: 4 }] } as unknown as EvaluationRecord;
  const comparable = JSON.stringify(replayComparable(record));
  assert.equal(comparable.includes('used'), false);
  assert.equal(comparable.includes('duration_ms'), true);
});

test('replay preserves a recorded timeout as jev-timeout after SDK error conversion', async () => {
  const value: ResolvedSelection = { model: 'jev-1.13.0', skip_below: 0.05, tasks: { check: { evidence: { description: 'check' } } } };
  const input = { selection: value, taskIds: ['check'], apiBaseUrl: 'https://api.typesafe.ai', apiModel: 'jev-1.13.0', apiKey: 'secret', timeoutMs: 20,
    state: { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), tested_sha: 'b'.repeat(40), changed_paths: ['source.txt'], diff: '' } };
  const live = createLiveTransport(async () => Response.json({ model: 'jev-1.13.0', answers: { check: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  await evaluateJev(input, live.fetch);
  const recorded = live.calls.map(call => ({ ...call, response: null, error: 'timeout', used: false }));
  const replay = createReplayTransport(recorded);
  await assert.rejects(evaluateJev(input, replay.fetch), error => error instanceof JevError && error.code === 'jev-timeout');
});

test('threshold metrics keep unknown labels separate and rank qualified omissions first', () => {
  const labels = { relevant: { relevance: 'relevant' as const, reason: 'must run' }, irrelevant: { relevance: 'irrelevant' as const, reason: 'unrelated' }, unknown: { relevance: 'unknown' as const, reason: 'uncertain' } };
  assert.deepEqual(metricsForLabels(labels, { relevant: true, irrelevant: false, unknown: null }),
    { relevant: 1, relevantMisses: 0, irrelevant: 1, correctIrrelevantOmissions: 1, irrelevantRetained: 0, unknown: 1, mismatches: 0 });
  const records = [0.05, 0.1].map((threshold, index) => ({
    version: 1, runId: `run-${index}`, source: {} as EvaluationRecord['source'], variant: { context: 'description' as const, questionMode: 'single' as const, grouping: 'natural' as const, maxGroupBytes: 1 }, repeat: 1,
    date: { started: '', finished: '' }, sdk: { package: '', version: '', model: null, requestedModel: null }, calls: [], observation: { strategy: 'whole-diff', status: 'complete', chunks: [] }, observationError: null,
    policy: { bypass: false, reason: null }, thresholds: { [threshold]: { threshold, decisions: {}, proposed: { relevant: true, irrelevant: index === 0 ? false : true, unknown: null }, effective: {}, tasks: { proposed: {}, effective: {} }, actionOutputs: { proposed: {}, effective: {} }, metrics: metricsForLabels(labels, { relevant: true, irrelevant: index === 0 ? false : true, unknown: null }) } }, error: null,
  } satisfies EvaluationRecord));
  const selection = chooseSelection(records, 'fingerprint');
  assert.equal(selection.qualified, true); assert.equal(selection.selected.threshold, 0.05); assert.equal(selection.metrics.correctIrrelevantOmissions, 1);
  const incomplete = { ...records[0]!, runId: 'incomplete', observation: { strategy: 'whole-diff' as const, status: 'incomplete' as const, chunks: [] } };
  const exploratory = chooseSelection([incomplete], 'fingerprint');
  assert.equal(exploratory.qualified, false); assert.equal(exploratory.metrics.failedRuns, 1);
});

test('campaign comparison reports deltas only for comparable settings', () => {
  const manifest = { version: 1, split: 'calibration', corpusFingerprint: 'same', cases: [{ id: 'case', split: 'calibration', caseFingerprint: 'case-fingerprint' }],
    variants: [{ context: 'description', questionMode: 'single', grouping: 'natural', maxGroupBytes: 49152 }], repeats: 3, thresholds: [0.05],
    sdk: { package: '@typesafe-ai/sdk', version: '0.6.0', model: null } } as NonNullable<Parameters<typeof compareCampaignData>[2]>;
  const row = (relevantMisses: number, usefulOmissions: number, repeat: number, partition: number) => ({ context: 'description', questions: 'single', threshold: 0.05,
    runs: 3, incomplete_runs: 0, metrics: { relevantMisses, correctIrrelevantOmissions: usefulOmissions }, repeat_disagreements: repeat, partition_disagreements: partition });
  const baseline = { runs: 3, calls: 3, tokens: { input: 10, output: 20 }, elapsed_ms: 100, mean_run_ms: 33, comparison: [row(2, 3, 1, 2)] } as Parameters<typeof compareCampaignData>[4];
  const current = { runs: 3, calls: 3, tokens: { input: 15, output: 30 }, elapsed_ms: 120, mean_run_ms: 40, comparison: [row(1, 5, 0, 1)] } as Parameters<typeof compareCampaignData>[5];
  const result = compareCampaignData('/baseline', '/current', manifest, manifest, baseline, current);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.metrics.relevant_misses, { baseline: 2, current: 1, delta: -1 });
  assert.deepEqual(result.metrics.useful_omissions, { baseline: 3, current: 5, delta: 2 });
  assert.deepEqual(result.stability.partition_disagreements, { baseline: 2, current: 1, delta: -1 });
  assert.deepEqual(result.tokens.total, { baseline: 30, current: 45, delta: 15 });
  assert.deepEqual(result.latency_ms.mean_run, { baseline: 33, current: 40, delta: 7 });

  const changed = { ...manifest, variants: [{ context: 'description', questionMode: 'single', grouping: 'natural', maxGroupBytes: 8192 }] } as Parameters<typeof compareCampaignData>[3];
  const guarded = compareCampaignData('/baseline', '/current', manifest, changed, baseline, current);
  assert.equal(guarded.comparable, false);
  assert.ok(guarded.guard.reasons.includes('settings:variants'));
  assert.equal(guarded.metrics.relevant_misses.delta, null);
});

test('threshold decisions compose raw split probabilities through production plans and outputs', () => {
  const value: ResolvedSelection = { model: 'jev-1.13.0', skip_below: 0.05, tasks: { check: { evidence: { description: 'check' } } } };
  const observation = { strategy: 'chunked-diff' as const, status: 'complete' as const, chunks: [
    { index: 0, start_byte: 0, end_byte: 1, diff_hash: 'a', state_hash: 'b', diff_bytes: 1, status: 'completed' as const, probabilities: { 'check::behavior': 0.01, 'check::verification': 0.02 }, model: 'jev-1.13.0', usage: null, duration_ms: 2, error: null },
    { index: 1, start_byte: 1, end_byte: 2, diff_hash: 'c', state_hash: 'd', diff_bytes: 1, status: 'completed' as const, probabilities: { 'check::behavior': 0.01, 'check::verification': 0.4 }, model: 'jev-1.13.0', usage: null, duration_ms: 2, error: null },
  ] };
  const decisions = decisionsFromObservation(observation, ['check'], 0.3, 'split');
  const plan = selectTasks({ selection: value, changedPaths: ['src/check.ts'], decisions, mode: 'enforce' });
  assert.equal(decisions.check, true); assert.equal(plan.tasks.check!.proposed_run, true); assert.deepEqual(actionOutputs(plan, 'a'.repeat(40), 'evaluation-report.json').check, 'true');
  assert.deepEqual(replayComparable({ version: 1, runId: 'r', source: {} as EvaluationRecord['source'], variant: { context: 'description', questionMode: 'split', grouping: 'natural', maxGroupBytes: 1 }, repeat: 1, date: { started: '', finished: '' }, sdk: { package: '', version: '', model: null, requestedModel: null }, calls: [], observation: null, observationError: null, policy: { bypass: false, reason: null }, thresholds: {}, error: null }), replayComparable({ version: 1, runId: 'r', source: {} as EvaluationRecord['source'], variant: { context: 'description', questionMode: 'split', grouping: 'natural', maxGroupBytes: 1 }, repeat: 1, date: { started: 'different', finished: 'different' }, sdk: { package: '', version: '', model: null, requestedModel: null }, calls: [], observation: null, observationError: null, policy: { bypass: false, reason: null }, thresholds: {}, error: null }));
});

test('offline replay reuses a captured SDK body and response through the production observation pipeline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-evaluation-smoke-'));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(root, 'cases', 'smoke', 'base'), { recursive: true });
    await mkdir(join(root, 'snapshots', 'smoke', 'repository', '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, 'cases', 'smoke', 'diff.patch'), 'diff --git a/source.txt b/source.txt\nnew file mode 100644\n--- /dev/null\n+++ b/source.txt\n@@ -0,0 +1 @@\n+source\n');
    await writeFile(join(root, 'snapshots', 'smoke', 'action-inputs.json'), JSON.stringify({ model: 'jev-1.13.0', 'skip-below': '0.05', tasks: stringify({
      unit: { description: 'Does this change affect unit verification?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'unit' }] },
      docs: { description: 'Does this change affect documentation?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'docs' }] },
    }) }));
    await writeFile(join(root, 'snapshots', 'smoke', 'repository', '.github', 'workflows', 'ci.yml'), 'jobs:\n  unit:\n    steps:\n      - run: npm test\n  docs:\n    steps:\n      - run: npm run docs\n');
    await writeFile(join(root, 'snapshots', 'smoke', 'repository', 'package.json'), JSON.stringify({ scripts: { test: 'node test.js', docs: 'node docs.js' } }));
    await writeFile(join(root, 'snapshots', 'smoke', 'external-actions.json'), '{}');
    await writeJson(join(root, 'corpus.json'), { version: 1, cases: [{ id: 'smoke', split: 'calibration', diff: 'cases/smoke/diff.patch', baseFiles: 'cases/smoke/base', snapshot: 'snapshots/smoke', expected: {
      unit: { relevance: 'relevant', reason: 'verification changes' }, docs: { relevance: 'irrelevant', reason: 'unrelated task' },
    }, provenance: { base: 'a'.repeat(40), head: 'b'.repeat(40), tested: 'b'.repeat(40), metadataCommit: 'a'.repeat(40) } }] });
    const corpus = await readCorpus(root);
    const loaded = await loadCase(root, corpus.cases[0]!);
    globalThis.fetch = async (_url, init) => {
      assert.equal(typeof init?.body, 'string');
      assert.ok(!String(init?.body).includes('secret-api-key'));
      return Response.json({ model: 'jev-1.13.0', answers: { docs: { type: 'noul', noul: 0.01 }, unit: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 2, output_tokens: 2 } });
    };
    const variant = { context: 'enriched' as const, questionMode: 'single' as const, grouping: 'natural' as const, maxGroupBytes: 48 * 1024 };
    const tooLarge = await evaluateRecord(loaded, { ...variant, maxGroupBytes: 1 }, 1, 'secret-api-key');
    assert.equal(tooLarge.observation, null);
    assert.equal(tooLarge.error, 'context-too-large');
    const record = await evaluateRecord(loaded, variant, 1, 'secret-api-key');
    assert.equal(record.observation?.status, 'complete');
    assert.equal(record.calls.length, 1);
    assert.equal(record.thresholds['0.05']!.proposed.unit, true);
    assert.equal(record.thresholds['0.05']!.proposed.docs, false);
    const campaign = join(root, 'campaign'); await mkdir(join(campaign, 'runs'), { recursive: true });
    const fingerprint = await corpusFingerprint(corpus, [loaded]);
    await writeJson(join(campaign, 'runs', 'run.json'), record);
    await writeJson(join(campaign, 'manifest.json'), { version: 1, command: 'live', split: 'calibration', corpusFingerprint: fingerprint,
      cases: [{ id: 'smoke', split: 'calibration', caseFingerprint: loaded.caseFingerprint }], variants: [variant], repeats: 1, thresholds: [0.05, 0.1, 0.2, 0.3, 0.5],
      sdk: { package: '@typesafe-ai/sdk', version: record.sdk.version, model: record.sdk.model }, created: '', updated: '', runs: ['runs/run.json'] });
    globalThis.fetch = async () => { throw new Error('replay must stay offline'); };
    assert.deepEqual(await replayCampaign(root, campaign), { checked: 1, stale: 0 });
    const inputsPath = join(root, 'snapshots', 'smoke', 'action-inputs.json');
    const inputs = JSON.parse(await readFile(inputsPath, 'utf8'));
    inputs.model = 'jev-1.13.1';
    await writeJson(inputsPath, inputs);
    await assert.rejects(replayCampaign(root, campaign), /replay-stale-request:corpus/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
