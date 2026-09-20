import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadCase, readCorpus, replayCampaign, resolveEvaluationCatalog } from '../evaluation/evaluation.js';

const root = resolve('tests/evaluation');

test('committed corpus has eight applicable diffs, complete trusted snapshots and independent labels', async () => {
  const corpus = await readCorpus(root);
  assert.equal(corpus.cases.filter(item => item.split === 'calibration').length, 4);
  assert.equal(corpus.cases.filter(item => item.split === 'validation').length, 4);
  for (const definition of corpus.cases) {
    assert.equal(definition.provenance.kind, 'synthetic');
    assert.equal(definition.provenance.repository, 'synthetic/generic-app');
    const loaded = await loadCase(root, definition);
    const { configured, resolved } = await resolveEvaluationCatalog(loaded, 'enriched');
    assert.deepEqual(Object.keys(definition.expected).sort(), Object.keys(configured.tasks).sort());
    assert.ok(loaded.changedPaths.length > 0, definition.id);
    assert.ok(Object.values(resolved.metadata.tasks).every(task => !task.incomplete), definition.id);
    for (const label of Object.values(definition.expected)) assert.ok(label.reason.trim().length > 0);
  }
});

test('committed provider recordings replay offline and preserve the frozen validation choice', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network access during committed replay'); };
  try {
    const calibration = join(root, 'recordings/calibration');
    const validation = join(root, 'recordings/validation');
    const choice = JSON.parse(await readFile(join(calibration, 'selection.json'), 'utf8'));
    const validationManifest = JSON.parse(await readFile(join(validation, 'manifest.json'), 'utf8'));
    assert.deepEqual(validationManifest.selection, choice);
    assert.deepEqual(await replayCampaign(root, calibration), { checked: 96, stale: 0 });
    assert.deepEqual(await replayCampaign(root, validation), { checked: 24, stale: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
