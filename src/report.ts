import Ajv from 'ajv';
import schema from '../schemas/report.schema.json';
import type { Observation } from './observations.js';
import type { ExecutionPlan } from './policy.js';
import type { Usage } from './jev.js';

export interface Report {
  version: 5;
  metadata_sha: string;
  base_sha: string;
  head_sha: string;
  tested_sha: string;
  selection_hash: string;
  skip_below: number;
  diff_hash: string | null;
  diff_bytes: number | null;
  changed_path_count: number | null;
  mode: ExecutionPlan['mode'];
  status: ExecutionPlan['status'];
  durations_ms: { collection: number; jev: number | null; total: number };
  usage: Usage | null;
  tasks: ExecutionPlan['tasks'];
  tested_ref: 'head' | 'merge';
  diff_base_sha: string | null;
  job_metadata: Record<string, unknown>;
  observation_error: string | null;
  model: { requested: string; expected: string; returned: string | null };
  observation: Observation | null;
}
const validate = new Ajv({ strict: true }).compile(schema);
export function validateReport(value: unknown): asserts value is Report {
  if (!validate(value)) throw new Error('invalid-report');
}
export function actionOutputs(plan: ExecutionPlan, testedSha: string, reportPath: string): Record<string, string> {
  return {
    run: JSON.stringify(plan.run), selected: JSON.stringify(plan.selected), matrix: JSON.stringify(plan.matrix),
    'has-tasks': String(plan.hasTasks), status: plan.status, 'tested-sha': testedSha, 'report-path': reportPath,
    ...Object.fromEntries(Object.keys(plan.run).sort().map(id => [id, String(plan.run[id])])),
  };
}

function observationSummary(observation: Observation | null): string[] {
  if (!observation) return ['Observation status: not-collected (no Jev call).'];
  const rows = observation.chunks.map(chunk => {
    const scores = chunk.probabilities
      ? Object.entries(chunk.probabilities).sort(([left], [right]) => left.localeCompare(right))
        .map(([id, probability]) => `${id}=${probability}`).join(', ') || '—'
      : '—';
    return `| ${chunk.index} | ${chunk.start_byte}–${chunk.end_byte} | ${chunk.diff_bytes} | ${chunk.status} | ${chunk.model ?? '—'} | ${chunk.duration_ms ?? '—'} | ${scores} | ${chunk.error ?? '—'} |`;
  });
  return [
    `Observation status: ${observation.status} (${observation.strategy}); ${observation.chunks.length} chunk(s).`,
    '',
    '| Chunk | Byte range | Diff bytes | Status | Model | Duration (ms) | Per-task scores | Error |',
    '| ---: | ---: | ---: | --- | --- | ---: | --- | --- |',
    ...rows,
    '',
    'Scores above are raw per-chunk Jev responses. No cross-chunk aggregate or global model probability is reported.',
  ];
}

export function summary(report: Report): string {
  const rows = Object.entries(report.tasks).sort(([a], [b]) => a.localeCompare(b)).map(([id, task]) =>
    `| ${id} | ${task.run ? 'Run' : 'Skip'} | ${task.proposed_run === null ? '—' : task.proposed_run ? 'Run' : 'Skip'} | ${task.reasons.join(', ')} |`);
  return [
    `### jev-ci-selector: ${report.status} (${report.mode})`,
    '', '| Task | Effective | Proposed | Reasons |',
    '| --- | --- | --- | --- |', ...rows, '',
    '<details>', '<summary>Selection details</summary>', '',
    `Tested commit: \`${report.tested_sha}\``, '',
    ...observationSummary(report.observation), '',
    'Scores are experimental selection signals, not guarantees about test outcomes.', '',
    '</details>', '',
  ].join('\n');
}
