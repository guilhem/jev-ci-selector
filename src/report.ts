import Ajv from 'ajv';
import schema from '../schemas/report.schema.json';
import type { ExecutionPlan } from './policy.js';
import type { Usage } from './jev.js';

export interface Report {
  version: 1;
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
  model: { requested: string; expected?: string; returned: string | null };
  durations_ms: { collection: number; jev: number | null; total: number };
  usage: Usage | null;
  tasks: ExecutionPlan['tasks'];
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
export function summary(report: Report): string {
  const rows = Object.entries(report.tasks).map(([id, task]) =>
    `| ${id} | ${task.probability ?? '—'} | ${task.proposed_run ?? '—'} | ${task.run} | ${task.reasons.join(', ')} |`);
  return [
    `### jev-ci-selector: ${report.status} (${report.mode})`,
    `Tested commit: \`${report.tested_sha}\``, '',
    '| Task | Probability | Proposed | Effective | Reasons |',
    '| --- | ---: | --- | --- | --- |', ...rows, '',
    'Probabilities are experimental selection signals, not guarantees about test outcomes.', '',
  ].join('\n');
}
