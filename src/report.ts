import Ajv from 'ajv';
import schema from '../schemas/report.schema.json';
import type { Observation } from './observations.js';
import type { ExecutionPlan } from './policy.js';
import type { Usage } from './jev.js';

interface ReportFields {
  config_sha: string;
  base_sha: string;
  head_sha: string;
  tested_sha: string;
  catalog_hash: string;
  diff_hash: string | null;
  diff_bytes: number | null;
  changed_path_count: number | null;
  mode: ExecutionPlan['mode'];
  status: ExecutionPlan['status'];
  durations_ms: { collection: number; jev: number | null; total: number };
  usage: Usage | null;
  tasks: ExecutionPlan['tasks'];
}
export type Report = ReportFields & (
  { version: 1; model: { requested: string; returned: string | null } } |
  { version: 2; model: { requested: string; expected: string; returned: string | null } } |
  { version: 3; model: { requested: string; expected: string; returned: string | null }; observation: Observation | null } |
  { version: 4; tested_ref: 'head' | 'merge'; diff_base_sha: string | null; job_metadata: Record<string, unknown>; observation_error: string | null; model: { requested: string; expected: string; returned: string | null }; observation: Observation | null }
);
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
  const rows = Object.entries(report.tasks).map(([id, task]) =>
    `| ${id} | ${task.probability ?? '—'} | ${task.proposed_run ?? '—'} | ${task.run} | ${task.reasons.join(', ')} |`);
  const observation = report.version >= 3 && 'observation' in report ? observationSummary(report.observation) : [];
  return [
    `### jev-ci-selector: ${report.status} (${report.mode})`,
    `Policy status: ${report.status} (${report.mode})`,
    `Tested commit: \`${report.tested_sha}\``, '',
    '| Task | Policy probability | Proposed | Effective | Reasons |',
    '| --- | ---: | --- | --- | --- |', ...rows, '',
    ...observation, '',
    'Probabilities are experimental selection signals, not guarantees about test outcomes.', '',
  ].join('\n');
}
