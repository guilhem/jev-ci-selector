import Ajv from 'ajv';
import schema from '../schemas/report.schema.json';
import type { Observation } from './observations.js';
import type { ExecutionPlan } from './policy.js';
import type { Usage } from './jev.js';
import type { ContextResolutionReport } from './context.js';
import type { BudgetCounters } from './budget.js';
import type { TaskState } from './observations.js';
import type { WindowReport } from './window.js';

/** Upper bound on the chunk records embedded in one report. */
export const MAX_REPORT_CHUNKS = 256;

export interface ReportManifest {
  /** False whenever the inventory hit a limit; then no new exclusion is valid. */
  complete: boolean;
  /** Identity of a complete inventory; null when it was not completed. */
  hash: string | null;
  change_count: number | null;
}

export interface ReportAnalysis extends BudgetCounters {
  /** Inventoried changes whose patch reached the analysis. */
  changes_read: number;
  /** Inventoried changes in total; a lower `changes_read` means an early stop. */
  changes_total: number | null;
  /**
   * The bytes-per-token ratio used to size requests: the declared prior, the
   * worst ratio observed, how many responses fed it, and what was applied.
   * The byte and token counts elsewhere are measured; this one is inferred.
   */
  bytes_per_token: WindowReport | null;
  analysed_tasks: string[];
  /** Tasks settled by the deterministic rules, for which nothing was read. */
  required_without_analysis: string[];
  task_states: Record<string, TaskState>;
  /** Per task: whether every obligation was actually discharged. */
  coverage: Record<string, boolean>;
  fallback_scope: 'none' | 'global' | 'partial';
  fallback_tasks: string[];
}

export interface Report {
  version: 8;
  metadata_sha: string;
  base_sha: string;
  head_sha: string;
  tested_sha: string;
  selection_hash: string;
  diff_hash: string | null;
  diff_bytes: number | null;
  changed_path_count: number | null;
  manifest: ReportManifest;
  analysis: ReportAnalysis;
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

function analysisSummary(report: Report): string[] {
  const { analysis, manifest } = report;
  const scope = analysis.fallback_scope === 'none'
    ? 'no fallback'
    : `${markdown(analysis.fallback_scope)} fallback: ${analysis.fallback_tasks.map(markdown).join(', ') || '—'}`;
  return [
    `Inventory: ${manifest.complete ? 'complete' : 'incomplete'}`
      + `, ${analysis.manifest_entries ?? '—'} change(s)`
      + `, hash ${manifest.hash ? manifest.hash.slice(0, 12) : '—'}.`,
    '',
    `Collection: ${analysis.changes_read}/${analysis.changes_total ?? '—'} change(s) read`
      + ` over ${analysis.patches_read}/${analysis.patches_requested} patch unit(s);`
      + ` ${analysis.patch_bytes_read} byte(s) read, ${analysis.patch_bytes_delivered} delivered.`,
    '',
    `Inference: ${analysis.jev_calls} call(s) and ${analysis.analysis_bytes} request byte(s)`
      + ` (preparation ${analysis.preparation_calls}/${analysis.preparation_bytes}, observation ${analysis.observation_calls}/${analysis.observation_bytes}).`,
    '',
    `Analysed: ${analysis.analysed_tasks.map(markdown).join(', ') || '—'};`
      + ` required without analysis: ${analysis.required_without_analysis.map(markdown).join(', ') || '—'}.`,
    '',
    `Limits reached: ${analysis.limits_reached.map(markdown).join(', ') || 'none'}; ${scope}.`,
    '',
    'Byte counts are real UTF-8/JSON sizes actually collected or sent. They are not token counts.',
  ];
}

function observationSummary(observation: Observation | null): string[] {
  if (!observation) return ['Observation status: not-collected (no Jev call).'];
  const rows = observation.chunks.map(chunk => {
    const judgments = chunk.judgments
      ? Object.entries(chunk.judgments).sort(([left], [right]) => left.localeCompare(right))
        .map(([id, answer]) => `${markdown(id)}=${markdown(answer.choice)} (${Object.entries(answer.probabilities).map(([option, probability]) => `${markdown(option)}=${probability}`).join(', ')}; confidence=${answer.confidence})`).join('; ')
      : '—';
    const changes = chunk.change_ids.slice(0, 8).map(markdown).join(', ')
      + (chunk.change_ids.length > 8 ? ` (+${chunk.change_ids.length - 8} more)` : '');
    return `| ${chunk.index} | ${chunk.unit_index} | ${changes || '—'} | ${chunk.diff_bytes} | ${markdown(chunk.status)} | ${markdown(chunk.model ?? '—')} | ${chunk.duration_ms ?? '—'} | ${judgments} | ${markdown(chunk.error ?? '—')} |`;
  });
  return [
    `Observation status: ${observation.status} (${observation.strategy}); ${observation.chunks.length} group(s).`,
    '',
    '| Group | Unit | Changes | Diff bytes | Status | Model | Duration (ms) | Per-task judgments | Error |',
    '| ---: | ---: | --- | ---: | --- | --- | ---: | --- | --- |',
    ...rows,
    '',
    'Values above are raw per-group Jev responses. No cross-group aggregate or global model probability is reported.',
    'A group marked not-needed was skipped because every task was already decided: that is a decision, not a failure.',
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
    ...analysisSummary(report), '',
    ...contextResolutionSummary(report.context_resolution), '',
    ...observationSummary(report.observation), '',
    'Jev judgments guide selection; they do not guarantee test outcomes.', '',
    '</details>', '',
  ].join('\n');
}
