import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson } from './evaluation.js';
import { summarizeCampaign } from './summary.js';

export interface ComparisonDelta {
  baseline: number | null;
  current: number;
  delta: number | null;
}

interface SummaryRow {
  context: string;
  runs: number;
  incomplete_runs: number;
  metrics: {
    relevantMisses: number;
    correctIrrelevantOmissions: number;
  };
  repeat_disagreements: number;
  partition_disagreements: number;
}

interface CampaignSummary {
  runs: number;
  calls: number;
  tokens: { input: number; output: number };
  elapsed_ms: number;
  mean_run_ms: number;
  comparison: SummaryRow[];
}

interface CampaignManifest {
  version: number;
  split: string | null;
  corpusFingerprint: string;
  cases: Array<{ id: string; split: string; caseFingerprint: string }>;
  variants: unknown[];
  repeats: number;
  sdk: { package: string; version: string; model: string | null };
  selection?: unknown;
}

interface ComparableSettings {
  version: number;
  split: string | null;
  corpusFingerprint: string;
  cases: CampaignManifest['cases'];
  variants: unknown[];
  repeats: number;
  sdk: CampaignManifest['sdk'];
  selection?: unknown;
}

export interface CampaignComparison {
  version: 1;
  baseline: string | null;
  current: string;
  comparable: boolean;
  guard: {
    comparable: boolean;
    reasons: string[];
    baseline: ComparableSettings | null;
    current: ComparableSettings;
  };
  metrics: {
    relevant_misses: ComparisonDelta;
    useful_omissions: ComparisonDelta;
  };
  stability: {
    repeat_disagreements: ComparisonDelta;
    partition_disagreements: ComparisonDelta;
  };
  tokens: {
    input: ComparisonDelta;
    output: ComparisonDelta;
    total: ComparisonDelta;
  };
  latency_ms: {
    elapsed: ComparisonDelta;
    mean_run: ComparisonDelta;
  };
  variants: Array<{
    key: string;
    baseline: { relevant_misses: number; useful_omissions: number; repeat_disagreements: number; partition_disagreements: number } | null;
    current: { relevant_misses: number; useful_omissions: number; repeat_disagreements: number; partition_disagreements: number };
    deltas: { relevant_misses: number | null; useful_omissions: number | null; repeat_disagreements: number | null; partition_disagreements: number | null };
  }>;
}

function settings(manifest: CampaignManifest): ComparableSettings {
  const result: ComparableSettings = {
    version: manifest.version,
    split: manifest.split,
    corpusFingerprint: manifest.corpusFingerprint,
    cases: [...manifest.cases].sort((left, right) => left.id.localeCompare(right.id)),
    variants: manifest.variants,
    repeats: manifest.repeats,
    sdk: manifest.sdk,
  };
  if (manifest.split === 'validation') result.selection = manifest.selection;
  return result;
}

function guard(baseline: ComparableSettings | null, current: ComparableSettings): { comparable: boolean; reasons: string[] } {
  if (!baseline) return { comparable: false, reasons: ['baseline-not-found'] };
  const reasons: string[] = [];
  for (const key of ['version', 'split', 'corpusFingerprint', 'cases', 'variants', 'repeats', 'sdk', 'selection'] as const) {
    if (canonicalJson(baseline[key] ?? null) !== canonicalJson(current[key] ?? null)) reasons.push(`settings:${key}`);
  }
  return { comparable: reasons.length === 0, reasons };
}

function delta(baseline: number | null, current: number, comparable: boolean): ComparisonDelta {
  return { baseline, current, delta: comparable && baseline !== null ? current - baseline : null };
}

function sumRows(rows: SummaryRow[], field: 'relevantMisses' | 'correctIrrelevantOmissions' | 'repeat_disagreements' | 'partition_disagreements'): number {
  return rows.reduce((total, row) => total + (field === 'relevantMisses' ? row.metrics.relevantMisses : field === 'correctIrrelevantOmissions' ? row.metrics.correctIrrelevantOmissions : row[field]), 0);
}

function rowKey(row: SummaryRow): string {
  return row.context;
}

export function compareCampaignData(
  baselinePath: string | null,
  currentPath: string,
  baselineManifest: CampaignManifest | null,
  currentManifest: CampaignManifest,
  baselineSummary: CampaignSummary | null,
  currentSummary: CampaignSummary,
): CampaignComparison {
  const baselineSettings = baselineManifest ? settings(baselineManifest) : null;
  const currentSettings = settings(currentManifest);
  const comparisonGuard = guard(baselineSettings, currentSettings);
  const baselineRows = new Map((baselineSummary?.comparison ?? []).map(row => [rowKey(row), row]));
  const currentRows = new Map(currentSummary.comparison.map(row => [rowKey(row), row]));
  const keys = [...new Set([...baselineRows.keys(), ...currentRows.keys()])].sort();
  const variants = keys.map(key => {
    const baseline = baselineRows.get(key);
    const current = currentRows.get(key);
    const currentValues = {
      relevant_misses: current?.metrics.relevantMisses ?? 0,
      useful_omissions: current?.metrics.correctIrrelevantOmissions ?? 0,
      repeat_disagreements: current?.repeat_disagreements ?? 0,
      partition_disagreements: current?.partition_disagreements ?? 0,
    };
    const baselineValues = baseline ? {
      relevant_misses: baseline.metrics.relevantMisses,
      useful_omissions: baseline.metrics.correctIrrelevantOmissions,
      repeat_disagreements: baseline.repeat_disagreements,
      partition_disagreements: baseline.partition_disagreements,
    } : null;
    return { key, baseline: baselineValues, current: currentValues,
      deltas: Object.fromEntries(Object.entries(currentValues).map(([name, value]) => [name, comparisonGuard.comparable && baselineValues ? value - baselineValues[name as keyof typeof baselineValues] : null])) as ReturnType<() => CampaignComparison['variants'][number]['deltas']> };
  });
  const baselineRowsValue = baselineSummary?.comparison ?? [];
  const currentRowsValue = currentSummary.comparison;
  const baselineInput = baselineSummary?.tokens.input ?? null;
  const baselineOutput = baselineSummary?.tokens.output ?? null;
  const currentInput = currentSummary.tokens.input;
  const currentOutput = currentSummary.tokens.output;
  return {
    version: 1, baseline: baselinePath, current: currentPath, comparable: comparisonGuard.comparable,
    guard: { ...comparisonGuard, baseline: baselineSettings, current: currentSettings },
    metrics: {
      relevant_misses: delta(baselineSummary ? sumRows(baselineRowsValue, 'relevantMisses') : null, sumRows(currentRowsValue, 'relevantMisses'), comparisonGuard.comparable),
      useful_omissions: delta(baselineSummary ? sumRows(baselineRowsValue, 'correctIrrelevantOmissions') : null, sumRows(currentRowsValue, 'correctIrrelevantOmissions'), comparisonGuard.comparable),
    },
    stability: {
      repeat_disagreements: delta(baselineSummary ? sumRows(baselineRowsValue, 'repeat_disagreements') : null, sumRows(currentRowsValue, 'repeat_disagreements'), comparisonGuard.comparable),
      partition_disagreements: delta(baselineSummary ? sumRows(baselineRowsValue, 'partition_disagreements') : null, sumRows(currentRowsValue, 'partition_disagreements'), comparisonGuard.comparable),
    },
    tokens: {
      input: delta(baselineInput, currentInput, comparisonGuard.comparable),
      output: delta(baselineOutput, currentOutput, comparisonGuard.comparable),
      total: delta(baselineSummary ? baselineInput! + baselineOutput! : null, currentInput + currentOutput, comparisonGuard.comparable),
    },
    latency_ms: {
      elapsed: delta(baselineSummary?.elapsed_ms ?? null, currentSummary.elapsed_ms, comparisonGuard.comparable),
      mean_run: delta(baselineSummary?.mean_run_ms ?? null, currentSummary.mean_run_ms, comparisonGuard.comparable),
    },
    variants,
  };
}

async function readManifest(path: string): Promise<CampaignManifest> {
  return JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as CampaignManifest;
}

export async function compareCampaigns(baselinePath: string | null, currentPath: string): Promise<CampaignComparison> {
  const currentManifest = await readManifest(currentPath);
  const currentSummary = await summarizeCampaign(currentPath) as CampaignSummary;
  if (!baselinePath) return compareCampaignData(null, currentPath, null, currentManifest, null, currentSummary);
  const baselineManifest = await readManifest(baselinePath);
  const baselineSummary = await summarizeCampaign(baselinePath) as CampaignSummary;
  return compareCampaignData(baselinePath, currentPath, baselineManifest, currentManifest, baselineSummary, currentSummary);
}

export async function resolveBaselineCampaign(explicitPath?: string): Promise<string | null> {
  if (!explicitPath) return null;
  const candidate = resolve(explicitPath);
  try {
    await access(join(candidate, 'manifest.json'));
    return candidate;
  } catch (error) {
    throw new Error(`baseline-not-found:${candidate}`);
  }
}
