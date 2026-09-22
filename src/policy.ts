import { minimatch } from 'minimatch';
import { validateResolvedSelection, type ResolvedSelection } from './tasks.js';

export type Mode = 'shadow' | 'enforce';
export type Status = 'planned' | 'bypassed' | 'fallback';
export const REASONS = [
  'always', 'path-match', 'jev-below-threshold', 'jev-at-or-above-threshold',
  'jev-independent', 'jev-not-independent',
  'shadow-mode', 'force-all', 'protected-path', 'fork',
  'missing-api-key', 'external-context-disabled', 'non-pull-request',
  'git-fetch-failed', 'git-read-failed', 'sha-incoherent', 'diff-too-large',
  'binary-change', 'submodule-change', 'unrepresentable-change',
  'jev-timeout', 'jev-error', 'invalid-response',
  'context-too-large', 'chunked-observation', 'observation-only', 'metadata-unavailable', 'observation-incomplete',
  'context-resolution-incomplete',
] as const;
export type Reason = typeof REASONS[number];
export interface ForceAllReason { status: 'bypassed' | 'fallback'; code: Reason }
export interface TaskDecision { proposed_run: boolean | null; run: boolean; reasons: Reason[] }
export interface ExecutionPlan {
  mode: Mode; status: Status; tasks: Record<string, TaskDecision>; run: Record<string, boolean>;
  selected: string[]; matrix: { include: { task: string }[] }; hasTasks: boolean;
}
const matches = (path: string, patterns: string[]): boolean =>
  patterns.some(pattern => minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true }));

export function globalPathReason(changedPaths: string[]): ForceAllReason | undefined {
  return changedPaths.some(path => path.startsWith('.github/workflows/'))
    ? { status: 'bypassed', code: 'protected-path' } : undefined;
}

function deterministic(selection: ResolvedSelection, paths: string[]): Record<string, Reason[]> {
  return Object.fromEntries(Object.keys(selection.tasks).sort().map(id => {
    const task = selection.tasks[id]!;
    const reasons: Reason[] = [];
    if (task.always) reasons.push('always');
    if (paths.some(path => matches(path, task.force_paths ?? []))) reasons.push('path-match');
    return [id, reasons];
  }));
}

export function selectTasks(input: {
  selection: ResolvedSelection; changedPaths: string[]; mode: Mode;
  decisions?: Readonly<Record<string, boolean | null>>;
  observationError?: Reason; forceAllReason?: ForceAllReason;
}): ExecutionPlan {
  const { selection, changedPaths, mode } = input;
  validateResolvedSelection(selection);
  if (mode !== 'shadow' && mode !== 'enforce') throw new Error('invalid-mode');
  const ids = Object.keys(selection.tasks).sort();
  const reasons = deterministic(selection, changedPaths);
  const candidates = ids.filter(id => reasons[id]!.length === 0);
  const decisions = input.decisions ?? {};
  let forced = input.forceAllReason ?? globalPathReason(changedPaths);
  if (!forced && (Object.keys(decisions).some(id => !ids.includes(id)) || Object.values(decisions).some(value => value !== null && typeof value !== 'boolean'))) {
    forced = { status: 'fallback', code: 'invalid-response' };
  }
  const incomplete = candidates.some(id => decisions[id] == null);
  const proposed = new Set(ids.filter(id => reasons[id]!.length));
  if (!forced) {
    for (const id of candidates) {
      if (decisions[id] == null) {
        proposed.add(id); reasons[id]!.push(input.observationError ?? 'observation-incomplete');
      } else if (decisions[id]) {
        proposed.add(id); reasons[id]!.push(selection.judgment === 'choice' ? 'jev-not-independent' : 'jev-at-or-above-threshold');
      } else reasons[id]!.push(selection.judgment === 'choice' ? 'jev-independent' : 'jev-below-threshold');
    }
  }
  const tasks: Record<string, TaskDecision> = {};
  const run: Record<string, boolean> = {};
  for (const id of ids) {
    const effective = !!forced || incomplete || mode === 'shadow' || proposed.has(id);
    tasks[id] = {
      proposed_run: forced || (candidates.includes(id) && decisions[id] == null) ? null : proposed.has(id),
      run: effective,
      reasons: forced ? [...new Set([...reasons[id]!, forced.code])] : [...reasons[id]!],
    };
    if (mode === 'shadow') tasks[id]!.reasons.push('shadow-mode');
    run[id] = effective;
  }
  const selected = ids.filter(id => run[id]);
  return { mode, status: forced?.status ?? (incomplete ? 'fallback' : 'planned'), tasks, run, selected,
    matrix: { include: selected.map(task => ({ task })) }, hasTasks: selected.length > 0 };
}
