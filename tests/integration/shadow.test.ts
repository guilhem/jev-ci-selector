import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectTasks } from '../../src/policy.js';
import { validateReport } from '../../src/report.js';
import { catalog } from '../fixtures/catalog.js';

test('shadow measurement joins by exact SHA and distinguishes regressions, flaky tests, infra and manual relevance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-shadow-test-'));
  try {
    const plan = selectTasks({ catalog: catalog(), changedPaths: [], probabilities: { helm: 0, e2e: 0, build: 0, prepare: 0 }, mode: 'shadow' });
    const report = { version: 1, config_sha: 'a'.repeat(40), base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), tested_sha: 'c'.repeat(40),
      catalog_hash: 'd'.repeat(64), diff_hash: 'e'.repeat(64), diff_bytes: 1, changed_path_count: 1, mode: 'shadow', status: 'planned',
      model: { requested: 'jev-1.13.0', returned: 'jev-1.13.0' }, durations_ms: { collection: 1, jev: 1, total: 2 },
      usage: { input_tokens: 1, output_tokens: 1 }, tasks: plan.tasks };
    validateReport(report);
    const results = { tested_sha: report.tested_sha, relevant_tasks: ['helm'], tasks: {
      build: { result: 'failure', classification: 'infrastructure', duration_ms: 30 },
      e2e: { result: 'failure', classification: 'regression', duration_ms: 40 },
      helm: { result: 'success', duration_ms: 20 },
      prepare: { result: 'failure', classification: 'flaky', duration_ms: 10 },
      unit: { result: 'success', duration_ms: 100 },
    } };
    const reportFile = join(directory, 'report.json'), resultsFile = join(directory, 'results.json');
    await writeFile(reportFile, JSON.stringify(report)); await writeFile(resultsFile, JSON.stringify(results));
    const args = [resolve('scripts/analyze-shadow.mjs'), reportFile, resultsFile];
    const analysis = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
    assert.equal(analysis.duration_ms_would_skip, 100);
    assert.deepEqual(analysis.failures_would_miss, { regression: ['e2e'], flaky: ['prepare'], infrastructure: ['build'], unknown: [] });
    assert.deepEqual(analysis.manually_relevant_would_skip, ['helm']);
    await writeFile(reportFile, JSON.stringify({ ...report,
      model: { requested: 'jev-1.13-free', expected: 'jev-1.13.0', returned: 'jev-1.13.0' } }));
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })), analysis);
    await writeFile(resultsFile, JSON.stringify({ ...results, tested_sha: 'f'.repeat(40) }));
    assert.equal(spawnSync(process.execPath, args).status, 1);
    await writeFile(resultsFile, JSON.stringify({ ...results, tasks: { unit: results.tasks.unit } }));
    assert.equal(spawnSync(process.execPath, args).status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
