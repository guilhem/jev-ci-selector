import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvaluationRecord, Selection, ThresholdMetrics } from './evaluation.js';

const emptyMetrics = (): ThresholdMetrics => ({ relevant: 0, relevantMisses: 0, irrelevant: 0,
  correctIrrelevantOmissions: 0, irrelevantRetained: 0, unknown: 0, mismatches: 0 });

export function summarizeRecords(records: EvaluationRecord[], selection?: Selection) {
  const rows = new Map<string, { context: string; questions: string; threshold: number; runs: number;
    incomplete_runs: number; metrics: ThresholdMetrics; repeat_disagreements: number; partition_disagreements: number }>();
  const repetitions = new Map<string, { row: string; values: Set<string> }>();
  const partitions = new Map<string, { row: string; values: Map<string, string> }>();
  let inputTokens = 0, outputTokens = 0, elapsedMs = 0, calls = 0;
  const models = new Set<string>();
  for (const record of records) {
    if (record.sdk.model) models.add(record.sdk.model);
    elapsedMs += Date.parse(record.date.finished) - Date.parse(record.date.started);
    calls += record.calls.length;
    for (const call of record.calls) {
      const body = call.response?.body as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
      const input = body?.usage?.input_tokens, output = body?.usage?.output_tokens;
      if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) inputTokens += input;
      if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) outputTokens += output;
    }
    for (const value of Object.values(record.thresholds)) {
      const key = `${record.variant.context}/${record.variant.questionMode}/${value.threshold}`;
      const row = rows.get(key) ?? { context: record.variant.context, questions: record.variant.questionMode,
        threshold: value.threshold, runs: 0, incomplete_runs: 0, metrics: emptyMetrics(), repeat_disagreements: 0, partition_disagreements: 0 };
      row.runs++;
      if (record.observation?.status !== 'complete' || record.observationError || record.error) row.incomplete_runs++;
      for (const metric of Object.keys(row.metrics) as Array<keyof ThresholdMetrics>) row.metrics[metric] += value.metrics[metric];
      rows.set(key, row);
      for (const [task, decision] of Object.entries(value.decisions)) {
        const repeatKey = `${key}/${record.source.caseId}/${record.variant.grouping}/${task}`;
        const repeated = repetitions.get(repeatKey) ?? { row: key, values: new Set<string>() };
        repeated.values.add(String(decision)); repetitions.set(repeatKey, repeated);
        const partitionKey = `${key}/${record.source.caseId}/${record.repeat}/${task}`;
        const partition = partitions.get(partitionKey) ?? { row: key, values: new Map<string, string>() };
        partition.values.set(record.variant.grouping, String(decision)); partitions.set(partitionKey, partition);
      }
    }
  }
  for (const item of repetitions.values()) if (item.values.size > 1) rows.get(item.row)!.repeat_disagreements++;
  for (const item of partitions.values()) if (item.values.size === 2 && new Set(item.values.values()).size > 1) rows.get(item.row)!.partition_disagreements++;
  const comparison = [...rows.values()].sort((a, b) => `${a.context}/${a.questions}`.localeCompare(`${b.context}/${b.questions}`) || a.threshold - b.threshold);
  const chosen = selection ? rows.get(`${selection.selected.context}/${selection.selected.questionMode}/${selection.selected.threshold}`) ?? null : null;
  return {
    runs: records.length, cases: [...new Set(records.map(record => record.source.caseId))], models: [...models].sort(),
    calls, tokens: { input: inputTokens, output: outputTokens },
    elapsed_ms: elapsedMs, mean_run_ms: records.length ? Math.round(elapsedMs / records.length) : 0,
    incomplete_runs: records.filter(record => record.observation?.status !== 'complete' || record.observationError || record.error).length,
    policy_bypassed_runs: records.filter(record => record.policy.bypass).length,
    selection: selection?.selected ?? null, chosen,
    qualified_on_this_split: !!selection?.qualified && !!chosen && chosen.incomplete_runs === 0 &&
      chosen.metrics.relevantMisses === 0 && chosen.metrics.correctIrrelevantOmissions > 0,
    comparison,
    interpretation: 'Counts are repeated task decisions, not independent pull requests. Omissions are semantic proposals; effective shadow outputs retain every task. No CI savings are measured. Repeat disagreements count case/task/grouping combinations; partition disagreements count case/task/repeat combinations.',
  };
}

export async function summarizeCampaign(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { runs: string[]; selection?: Selection; split: string };
  const records: EvaluationRecord[] = await Promise.all(manifest.runs.map(async path => JSON.parse(await readFile(join(directory, path), 'utf8'))));
  return { split: manifest.split, ...summarizeRecords(records, manifest.selection) };
}
