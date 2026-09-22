import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateReport } from '../../src/report.js';

test('shadow measurement joins by exact SHA and distinguishes regressions, flaky tests, infra and manual relevance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-shadow-test-'));
  try {
    const tasks = Object.fromEntries(['build', 'e2e', 'helm', 'prepare', 'unit'].map(id => [id, {
      proposed_run: id === 'unit', run: true, reasons: [id === 'unit' ? 'always' : 'jev-independent', 'shadow-mode'],
    }]));
    const report = { version: 8, metadata_sha: 'a'.repeat(40), base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), tested_sha: 'c'.repeat(40),
      tested_ref: 'merge', diff_base_sha: 'a'.repeat(40), job_metadata: {}, observation: null, observation_error: null,
      selection_hash: 'd'.repeat(64), diff_hash: 'e'.repeat(64), diff_bytes: 1, changed_path_count: 1, mode: 'shadow', status: 'planned',
      model: { requested: 'provider/alias', expected: 'jev-1.13.0', returned: 'jev-1.13.0' }, durations_ms: { collection: 1, jev: 1, total: 2 },
      usage: { input_tokens: 1, output_tokens: 1 }, tasks, context_resolution: {},
      manifest: { complete: true, hash: 'f'.repeat(64), change_count: 1 },
      analysis: { manifest_entries: 1, patches_requested: 1, patches_read: 1, collected_patch_bytes: 1,
        preparation_calls: 0, preparation_bytes: 0, observation_calls: 1, observation_bytes: 1,
        jev_calls: 1, analysis_bytes: 1, limits_reached: [],
        analysed_tasks: ['build', 'e2e', 'helm', 'prepare', 'unit'], required_without_analysis: [],
        task_states: {}, coverage: {}, fallback_scope: 'none', fallback_tasks: [] } };
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
    const standalone = join(directory, 'analyze-shadow.mjs');
    await copyFile(resolve('dist/analyze-shadow.mjs'), standalone);
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, [standalone, reportFile, resultsFile], {
      cwd: directory, encoding: 'utf8',
    })), analysis, 'distributed analyzer works without the repository or installed dependencies');
    assert.equal(analysis.duration_ms_would_skip, 100);
    assert.deepEqual(analysis.failures_would_miss, { regression: ['e2e'], flaky: ['prepare'], infrastructure: ['build'], unknown: [] });
    assert.deepEqual(analysis.manually_relevant_would_skip, ['helm']);
    assert.equal(analysis.selection_hash, report.selection_hash);
    assert.equal(Object.hasOwn(analysis, 'catalog_hash'), false);
    for (const version of [1, 2, 3, 4, 5, 6, 7, 9]) {
      await writeFile(reportFile, JSON.stringify({ ...report, version }));
      assert.equal(spawnSync(process.execPath, args).status, 1);
      assert.equal(spawnSync(process.execPath, [standalone, reportFile, resultsFile]).status, 1);
    }
    await writeFile(reportFile, JSON.stringify(report));
    await writeFile(resultsFile, JSON.stringify({ ...results, tested_sha: 'f'.repeat(40) }));
    assert.equal(spawnSync(process.execPath, args).status, 1);
    await writeFile(resultsFile, JSON.stringify({ ...results, tasks: { unit: results.tasks.unit } }));
    assert.equal(spawnSync(process.execPath, args).status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
