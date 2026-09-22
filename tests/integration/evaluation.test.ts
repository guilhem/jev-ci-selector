import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, loadCase, readCorpus, replayCampaign, replayChoiceRegressions, resolveEvaluationSelection } from '../evaluation/evaluation.js';

const root = resolve('tests/evaluation');

test('historical Noul archives preserve their original provider evidence', async () => {
  const proof = JSON.parse(await readFile(join(root, 'recordings/migration-proof.json'), 'utf8'));
  for (const campaign of ['calibration', 'validation']) {
    const directory = join(root, 'recordings', campaign);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const frozen = [];
    for (const run of manifest.runs) {
      const record = JSON.parse(await readFile(join(directory, run), 'utf8'));
      frozen.push({ run, calls: record.calls, observation: record.observation, sdk: record.sdk, date: record.date });
    }
    assert.equal(frozen.length, proof.campaigns[campaign].records);
    assert.equal(createHash('sha256').update(canonicalJson(frozen)).digest('hex'), proof.campaigns[campaign].immutable_sha256);
  }
});

test('committed corpus has eight applicable diffs, complete trusted snapshots and independent labels', async () => {
  const corpus = await readCorpus(root);
  assert.equal(corpus.cases.filter(item => item.split === 'calibration').length, 4);
  assert.equal(corpus.cases.filter(item => item.split === 'validation').length, 4);
  for (const definition of corpus.cases) {
    assert.equal(definition.provenance.kind, 'synthetic');
    assert.equal(definition.provenance.repository, 'synthetic/generic-app');
    const loaded = await loadCase(root, definition);
    const { configured, resolved } = await resolveEvaluationSelection(loaded, 'enriched');
    assert.deepEqual(Object.keys(definition.expected).sort(), Object.keys(configured.tasks).sort());
    assert.ok(loaded.changedPaths.length > 0, definition.id);
    assert.ok(Object.values(resolved.metadata.tasks).every(task => !task.incomplete), definition.id);
    for (const label of Object.values(definition.expected)) assert.ok(label.reason.trim().length > 0);
  }
});

test('current Choice evidence replays offline and historical campaigns are rejected by the current runner', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network access during committed replay'); };
  try {
    assert.deepEqual(await replayChoiceRegressions(join(root, 'recordings/choice-regressions.json')), { checked: 2, stale: 0 });
    await assert.rejects(replayCampaign(root, join(root, 'recordings/calibration')), /invalid-campaign/);
    await assert.rejects(replayCampaign(root, join(root, 'recordings/validation')), /invalid-campaign/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
