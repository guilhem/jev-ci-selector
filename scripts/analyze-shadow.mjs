import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import schema from '../schemas/report.schema.json' with { type: 'json' };

const validate = new Ajv({ strict: true }).compile(schema);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function analyzeShadow(report, results) {
  if (!validate(report) || report.mode !== 'shadow' || !object(results) || results.tested_sha !== report.tested_sha || !object(results.tasks)) {
    throw new Error('invalid-shadow-measurement');
  }
  const ids = Object.keys(report.tasks).sort();
  if (JSON.stringify(ids) !== JSON.stringify(Object.keys(results.tasks).sort())) throw new Error('task-results-mismatch');
  const relevant = results.relevant_tasks ?? [];
  if (!Array.isArray(relevant) || relevant.some(id => !ids.includes(id)) || new Set(relevant).size !== relevant.length) throw new Error('invalid-manual-labels');
  const avoided = [];
  const missed = { regression: [], flaky: [], infrastructure: [], unknown: [] };
  const unobserved = [];
  let avoidedDurationMs = 0;
  for (const id of ids) {
    const actual = results.tasks[id];
    if (!object(actual) || !['success', 'failure', 'cancelled', 'skipped'].includes(actual.result) ||
      !Number.isFinite(actual.duration_ms) || actual.duration_ms < 0 ||
      (actual.classification !== undefined && !Object.hasOwn(missed, actual.classification))) throw new Error('invalid-task-result');
    if (report.tasks[id].run !== true) throw new Error('invalid-shadow-effective-selection');
    if (report.tasks[id].proposed_run === false) {
      avoided.push(id);
      avoidedDurationMs += actual.duration_ms;
      if (actual.result === 'failure') missed[actual.classification ?? 'unknown'].push(id);
      if (actual.result === 'skipped' || actual.result === 'cancelled') unobserved.push(id);
    }
  }
  return {
    tested_sha: report.tested_sha, catalog_hash: report.catalog_hash,
    status: report.status, fallback: report.status === 'fallback',
    tasks_total: ids.length, tasks_would_skip: avoided, duration_ms_would_skip: avoidedDurationMs,
    failures_would_miss: missed, skipped_or_cancelled_would_skip: unobserved,
    manually_relevant_would_skip: relevant.filter(id => avoided.includes(id)).sort(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('usage');
    const [report, results] = await Promise.all(process.argv.slice(2).map(async file => JSON.parse(await readFile(file, 'utf8'))));
    console.log(JSON.stringify(analyzeShadow(report, results), null, 2));
  } catch {
    console.error('Invalid shadow measurement. Usage: node analyze-shadow.mjs report.json results.json');
    process.exitCode = 1;
  }
}
