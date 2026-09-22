import Ajv from 'ajv';
import schema from '../schemas/report.schema.json';
import type { Observation } from './observations.js';
import type { ExecutionPlan } from './policy.js';
import type { Usage } from './jev.js';
import type { ContextResolutionReport } from './context.js';
import type { Judgment } from './tasks.js';

export interface Report {
  version: 7;
  judgment: Judgment;
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
  context_resolution: ContextResolutionReport;
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

function markdown(value: string): string {
  return value.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
    .replace(/[\\|`]/g, '\\$&').replace(/[\r\n\u0000]/g, ' ');
}

function observationSummary(observation: Observation | null): string[] {
  if (!observation) return ['Observation status: not-collected (no Jev call).'];
  const rows = observation.chunks.map(chunk => {
    const scores = chunk.judgments
      ? Object.entries(chunk.judgments).sort(([left], [right]) => left.localeCompare(right))
        .map(([id, answer]) => `${markdown(id)}=${markdown(answer.choice)} (${Object.entries(answer.probabilities).map(([option, probability]) => `${markdown(option)}=${probability}`).join(', ')}; confidence=${answer.confidence})`).join('; ')
      : chunk.probabilities
      ? Object.entries(chunk.probabilities).sort(([left], [right]) => left.localeCompare(right))
        .map(([id, probability]) => `${markdown(id)}=${probability}`).join(', ') || '—'
      : '—';
    return `| ${chunk.index} | ${chunk.start_byte}–${chunk.end_byte} | ${chunk.diff_bytes} | ${markdown(chunk.status)} | ${markdown(chunk.model ?? '—')} | ${chunk.duration_ms ?? '—'} | ${scores} | ${markdown(chunk.error ?? '—')} |`;
  });
  return [
    `Observation status: ${observation.status} (${observation.strategy}); ${observation.chunks.length} chunk(s).`,
    '',
    '| Chunk | Byte range | Diff bytes | Status | Model | Duration (ms) | Per-task judgments | Error |',
    '| ---: | ---: | ---: | --- | --- | ---: | --- | --- |',
    ...rows,
    '',
    'Values above are raw per-chunk Jev responses. No cross-chunk aggregate or global model probability is reported.',
  ];
}

function contextResolutionSummary(contextResolution: ContextResolutionReport): string[] {
  const entries = Object.entries(contextResolution).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return ['Context resolution: not-run (disabled or bypassed).'];
  const rows = entries.map(([anchor, resolution]) => {
    const visibleSources = resolution.sources.slice(0, 20).map(source => markdown(source.path));
    const sourceSummary = `${resolution.sources.length} file(s): ${visibleSources.join(', ') || '—'}${resolution.sources.length > visibleSources.length ? ` (+${resolution.sources.length - visibleSources.length} more)` : ''}`;
    const passSummary = resolution.passes.map(pass => {
      const visibleCalls = pass.calls.slice(0, 12).map(call => {
        const usage = call.usage ? ` ${call.usage.input_tokens}/${call.usage.output_tokens} tokens` : '';
        const duration = call.duration_ms === null ? '' : ` ${call.duration_ms}ms`;
        const error = call.error ? ` ${markdown(call.error)}` : '';
        return `${markdown(call.status)}/${call.request_hash.slice(0, 12)}${error}${usage}${duration}`;
      });
      const omitted = pass.calls.length > visibleCalls.length ? ` (+${pass.calls.length - visibleCalls.length} more)` : '';
      return `p${pass.index}: ${pass.calls.length} request(s) [${visibleCalls.join('; ') || '—'}]${omitted}`;
    }).join('; ') || '—';
    return `| ${markdown(anchor)} | ${markdown(resolution.status)} | ${sourceSummary} | ${passSummary} | ${markdown(resolution.error ?? '—')} |`;
  });
  return [
    `Context resolution: ${entries.length} workflow/job group(s).`,
    '',
    '| Workflow/job | Status | Selected files | Preparation passes (requests, status/error, hash, usage, time) | Error |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Context evidence includes selected paths and request hashes only; file contents, diffs, judgments and probabilities are omitted.',
  ];
}

export function summary(report: Report): string {
  const rows = Object.entries(report.tasks).sort(([a], [b]) => a.localeCompare(b)).map(([id, task]) =>
    `| ${markdown(id)} | ${task.run ? 'Run' : 'Skip'} | ${task.proposed_run === null ? '—' : task.proposed_run ? 'Run' : 'Skip'} | ${task.reasons.map(markdown).join(', ')} |`);
  return [
    `### jev-ci-selector: ${markdown(report.status)} (${markdown(report.mode)})`,
    '', '| Task | Effective | Proposed | Reasons |',
    '| --- | --- | --- | --- |', ...rows, '',
    '<details>', '<summary>Selection details</summary>', '',
    `Tested commit: \`${markdown(report.tested_sha)}\``, '',
    `Judgment: ${report.judgment}${report.judgment === 'choice' ? ' (skip only independent; skip-below unused)' : ` (skip-below=${report.skip_below})`}.`, '',
    ...contextResolutionSummary(report.context_resolution), '',
    ...observationSummary(report.observation), '',
    'Scores are experimental selection signals, not guarantees about test outcomes.', '',
    '</details>', '',
  ].join('\n');
}
