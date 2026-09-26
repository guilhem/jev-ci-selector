import { validateSelection, type SelectionDefinition } from './tasks.js';

export type Status = 'planned' | 'bypassed' | 'fallback';
export const REASONS = [
  'jev-independent', 'jev-not-independent',
  'fork', 'missing-api-key', 'external-context-disabled',
  'git-fetch-failed', 'git-read-failed', 'sha-incoherent', 'diff-too-large',
  'binary-change', 'submodule-change', 'unrepresentable-change', 'manifest-incomplete',
  'analysis-budget-exceeded', 'patch-unavailable', 'coverage-incomplete',
  'jev-timeout', 'jev-error', 'invalid-response', 'jev-rate-limited', 'jev-payment-required',
  'context-too-large', 'chunked-observation', 'observation-incomplete',
] as const;
export type Reason = typeof REASONS[number];

/**
 * Reasons that mean "kept because the evidence was missing or unusable", as
 * opposed to a positive decision. A task carrying one of
 * these is part of the fallback, whatever its proposal ended up being.
 */
export const FALLBACK_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  'git-fetch-failed', 'git-read-failed', 'sha-incoherent', 'diff-too-large',
  'binary-change', 'submodule-change', 'unrepresentable-change', 'manifest-incomplete',
  'analysis-budget-exceeded', 'patch-unavailable', 'coverage-incomplete',
  'jev-timeout', 'jev-error', 'invalid-response', 'jev-rate-limited', 'jev-payment-required', 'context-too-large',
  'observation-incomplete',
]);
export interface SafetyReason { status: 'bypassed' | 'fallback'; code: Reason }
export interface TaskDecision { proposed_run: boolean | null; run: boolean; reasons: Reason[] }
export interface ExecutionPlan {
  status: Status; tasks: Record<string, TaskDecision>; run: Record<string, boolean>;
  selected: string[]; matrix: { include: { task: string }[] }; hasTasks: boolean;
}
export function selectTasks(input: {
  selection: SelectionDefinition;
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
  observationError?: Reason; safetyReason?: SafetyReason;
}): ExecutionPlan {
  const { selection } = input;
  validateSelection(selection);
  const ids = Object.keys(selection.tasks).sort();
  const reasons: Record<string, Reason[]> = Object.fromEntries(ids.map(id => [id, []]));
  const decisions = input.decisions ?? {};
  const coverage = input.coverage ?? {};
  const taskErrors = input.taskErrors ?? {};
  let forced = input.safetyReason;
  if (!forced && (Object.keys(decisions).some(id => !ids.includes(id)) || Object.values(decisions).some(value => value !== null && typeof value !== 'boolean'))) {
    forced = { status: 'fallback', code: 'invalid-response' };
  }
  const proposed = new Set<string>();
  // Missing evidence is scoped to the tasks it actually concerns. A task whose
  // own coverage is complete keeps its decision even when another task failed.
  const unresolved = new Set<string>();
  if (!forced) {
    for (const id of ids) {
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
    const effective = !!forced || proposed.has(id);
    tasks[id] = {
      proposed_run: forced || unresolved.has(id) ? null : proposed.has(id),
      run: effective,
      reasons: forced ? [...new Set([...reasons[id]!, forced.code])] : [...reasons[id]!],
    };
    run[id] = effective;
  }
  const selected = ids.filter(id => run[id]);
  return { status: forced?.status ?? (unresolved.size ? 'fallback' : 'planned'), tasks, run, selected,
    matrix: { include: selected.map(task => ({ task })) }, hasTasks: selected.length > 0 };
}
