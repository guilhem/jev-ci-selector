import { minimatch } from 'minimatch';
import { validateSelection, type SelectionDefinition } from './tasks.js';

export type Mode = 'shadow' | 'enforce';
export type Status = 'planned' | 'bypassed' | 'fallback';
export const REASONS = [
  'always', 'path-match',
  'jev-independent', 'jev-not-independent',
  'shadow-mode', 'force-all', 'protected-path', 'fork',
  'missing-api-key', 'external-context-disabled', 'non-pull-request',
  'git-fetch-failed', 'git-read-failed', 'sha-incoherent', 'diff-too-large',
  'binary-change', 'submodule-change', 'unrepresentable-change', 'manifest-incomplete',
  'analysis-budget-exceeded', 'patch-unavailable', 'coverage-incomplete',
  'jev-timeout', 'jev-error', 'invalid-response', 'jev-rate-limited', 'jev-payment-required',
  'context-too-large', 'chunked-observation', 'observation-only', 'observation-incomplete',
] as const;
export type Reason = typeof REASONS[number];

/**
 * Reasons that mean "kept because the evidence was missing or unusable", as
 * opposed to a positive decision or a configured rule. A task carrying one of
 * these is part of the fallback, whatever its proposal ended up being.
 */
export const FALLBACK_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  'git-fetch-failed', 'git-read-failed', 'sha-incoherent', 'diff-too-large',
  'binary-change', 'submodule-change', 'unrepresentable-change', 'manifest-incomplete',
  'analysis-budget-exceeded', 'patch-unavailable', 'coverage-incomplete',
  'jev-timeout', 'jev-error', 'invalid-response', 'jev-rate-limited', 'jev-payment-required', 'context-too-large',
  'observation-incomplete',
]);
export interface ForceAllReason { status: 'bypassed' | 'fallback'; code: Reason }
export interface TaskDecision { proposed_run: boolean | null; run: boolean; reasons: Reason[] }
export interface ExecutionPlan {
  mode: Mode; status: Status; tasks: Record<string, TaskDecision>; run: Record<string, boolean>;
  selected: string[]; matrix: { include: { task: string }[] }; hasTasks: boolean;
}
export interface Preselection {
  /** Deterministic reasons per task; empty for a task still open to analysis. */
  reasons: Record<string, Reason[]>;
  /** Tasks whose execution is already settled by the configuration alone. */
  required: string[];
  /** Tasks whose execution is still undecided and may be worth analysing. */
  candidates: string[];
}
const matches = (path: string, patterns: string[]): boolean =>
  patterns.some(pattern => minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true }));

export function globalPathReason(changedPaths: readonly string[]): ForceAllReason | undefined {
  return changedPaths.some(path => path.startsWith('.github/workflows/'))
    ? { status: 'bypassed', code: 'protected-path' } : undefined;
}

/**
 * The single deterministic rule set, evaluated before any content is read.
 *
 * Every path of the manifest is examined, old paths and deletions included, so
 * a deletion or a rename out of a protected location cannot slip past
 * `force_paths`. It reads no file, resolves no metadata and calls no provider.
 */
export function preselectTasks(selection: SelectionDefinition, changedPaths: readonly string[]): Preselection {
  const ids = Object.keys(selection.tasks).sort();
  const reasons: Record<string, Reason[]> = {};
  for (const id of ids) {
    const task = selection.tasks[id]!;
    const taskReasons: Reason[] = [];
    if (task.always) taskReasons.push('always');
    if (changedPaths.some(path => matches(path, task.force_paths ?? []))) taskReasons.push('path-match');
    reasons[id] = taskReasons;
  }
  return {
    reasons,
    required: ids.filter(id => reasons[id]!.length > 0),
    candidates: ids.filter(id => reasons[id]!.length === 0),
  };
}

export function selectTasks(input: {
  selection: SelectionDefinition; changedPaths: readonly string[]; mode: Mode;
  decisions?: Readonly<Record<string, boolean | null>>;
  /**
   * Per candidate: whether every relevant change was actually covered by the
   * analysis. When this registry is supplied an exclusion requires an explicit
   * `true`, so an unread change can never become independent by default. The
   * planner always supplies it; omitting it keeps the decisions-only contract
   * used by callers that own their coverage proof.
   */
  coverage?: Readonly<Record<string, boolean>>;
  /** Per candidate: why its own analysis could not conclude. */
  taskErrors?: Readonly<Record<string, Reason>>;
  observationError?: Reason; forceAllReason?: ForceAllReason;
}): ExecutionPlan {
  const { selection, changedPaths, mode } = input;
  validateSelection(selection);
  if (mode !== 'shadow' && mode !== 'enforce') throw new Error('invalid-mode');
  const ids = Object.keys(selection.tasks).sort();
  const { reasons, candidates } = preselectTasks(selection, changedPaths);
  const decisions = input.decisions ?? {};
  const coverage = input.coverage ?? {};
  const taskErrors = input.taskErrors ?? {};
  let forced = input.forceAllReason ?? globalPathReason(changedPaths);
  if (!forced && (Object.keys(decisions).some(id => !ids.includes(id)) || Object.values(decisions).some(value => value !== null && typeof value !== 'boolean'))) {
    forced = { status: 'fallback', code: 'invalid-response' };
  }
  const proposed = new Set(ids.filter(id => reasons[id]!.length));
  // Missing evidence is scoped to the tasks it actually concerns. A task whose
  // own coverage is complete keeps its decision even when another task failed.
  const unresolved = new Set<string>();
  if (!forced) {
    for (const id of candidates) {
      if (decisions[id] == null) {
        proposed.add(id); unresolved.add(id);
        reasons[id]!.push(taskErrors[id] ?? input.observationError ?? 'observation-incomplete');
      } else if (decisions[id]) {
        proposed.add(id); reasons[id]!.push('jev-not-independent');
      } else if (input.coverage !== undefined && coverage[id] !== true) {
        // An exclusion never coexists with a missing coverage obligation.
        proposed.add(id); unresolved.add(id);
        reasons[id]!.push(taskErrors[id] ?? 'coverage-incomplete');
      } else reasons[id]!.push('jev-independent');
    }
  }
  const tasks: Record<string, TaskDecision> = {};
  const run: Record<string, boolean> = {};
  for (const id of ids) {
    const effective = !!forced || mode === 'shadow' || proposed.has(id);
    tasks[id] = {
      proposed_run: forced || unresolved.has(id) ? null : proposed.has(id),
      run: effective,
      reasons: forced ? [...new Set([...reasons[id]!, forced.code])] : [...reasons[id]!],
    };
    if (mode === 'shadow') tasks[id]!.reasons.push('shadow-mode');
    run[id] = effective;
  }
  const selected = ids.filter(id => run[id]);
  return { mode, status: forced?.status ?? (unresolved.size ? 'fallback' : 'planned'), tasks, run, selected,
    matrix: { include: selected.map(task => ({ task })) }, hasTasks: selected.length > 0 };
}
