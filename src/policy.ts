import { minimatch } from 'minimatch';
import { validateCatalog, type Catalog } from './config.js';

export type Mode = 'shadow' | 'enforce';
export type Status = 'planned' | 'bypassed' | 'fallback';
export const REASONS = [
  'always', 'path-match', 'dependency', 'jev-below-threshold', 'jev-at-or-above-threshold',
  'shadow-mode', 'force-all', 'protected-path', 'configured-force-path', 'fork',
  'missing-api-key', 'external-context-disabled', 'non-pull-request',
  'git-fetch-failed', 'git-read-failed', 'sha-incoherent', 'diff-too-large',
  'binary-change', 'submodule-change', 'unrepresentable-change',
  'jev-timeout', 'jev-error', 'invalid-response',
  'context-too-large', 'chunked-observation', 'observation-only', 'metadata-unavailable', 'observation-incomplete',
] as const;
export type Reason = typeof REASONS[number];
export interface ForceAllReason { status: 'bypassed' | 'fallback'; code: Reason }
export interface TaskDecision {
  probability: number | null;
  proposed_run: boolean | null;
  run: boolean;
  reasons: Reason[];
}
export interface ExecutionPlan {
  mode: Mode;
  status: Status;
  tasks: Record<string, TaskDecision>;
  run: Record<string, boolean>;
  selected: string[];
  matrix: { include: { task: string }[] };
  hasTasks: boolean;
}
const matches = (path: string, patterns: string[]): boolean =>
  patterns.some(pattern => minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true }));

export function globalPathReason(catalog: Catalog, changedPaths: string[], configPath = '.github/task-routing.yaml'): ForceAllReason | undefined {
  if (changedPaths.some(path => path === configPath || path.startsWith('.github/workflows/'))) {
    return { status: 'bypassed', code: 'protected-path' };
  }
  if (changedPaths.some(path => matches(path, catalog.force_all_paths ?? []))) {
    return { status: 'bypassed', code: 'configured-force-path' };
  }
  return undefined;
}

function deterministic(catalog: Catalog, paths: string[]): Record<string, Reason[]> {
  const reasons: Record<string, Reason[]> = {};
  for (const id of Object.keys(catalog.tasks).sort()) {
    const task = catalog.tasks[id]!;
    reasons[id] = [];
    if (task.always) reasons[id]!.push('always');
    if (paths.some(path => matches(path, task.force_paths ?? []))) reasons[id]!.push('path-match');
  }
  closeDependencies(catalog, new Set(Object.keys(reasons).filter(id => reasons[id]!.length)), reasons);
  return reasons;
}

function closeDependencies(catalog: Catalog, selected: Set<string>, reasons: Record<string, Reason[]>): void {
  const visit = (id: string): void => {
    for (const dependency of [...(catalog.tasks[id]!.requires ?? [])].sort()) {
      if (!reasons[dependency]!.includes('dependency')) reasons[dependency]!.push('dependency');
      if (!selected.has(dependency)) { selected.add(dependency); visit(dependency); }
    }
  };
  for (const id of [...selected].sort()) visit(id);
}

export function semanticTaskIds(catalog: Catalog, changedPaths: string[]): string[] {
  validateCatalog(catalog);
  const reasons = deterministic(catalog, changedPaths);
  return Object.keys(reasons).filter(id => reasons[id]!.length === 0);
}

export function selectTasks(input: {
  catalog: Catalog;
  changedPaths: string[];
  probabilities?: Readonly<Record<string, unknown>>;
  mode: Mode;
  decisions?: Readonly<Record<string, boolean | null>>;
  observationError?: Reason;
  forceAllReason?: ForceAllReason;
  configPath?: string;
}): ExecutionPlan {
  const { catalog, changedPaths, mode } = input;
  validateCatalog(catalog);
  if (mode !== 'shadow' && mode !== 'enforce') throw new Error('invalid-mode');
  const ids = Object.keys(catalog.tasks).sort();
  const reasons = deterministic(catalog, changedPaths);
  const candidates = ids.filter(id => reasons[id]!.length === 0);
  let forced = input.forceAllReason ?? globalPathReason(catalog, changedPaths, input.configPath);
  const probabilities = input.probabilities ?? {};
  if (!input.decisions && !forced && (Object.keys(probabilities).some(id => !candidates.includes(id)) || candidates.some(id =>
    !Object.hasOwn(probabilities, id) || typeof probabilities[id] !== 'number' ||
    !Number.isFinite(probabilities[id]) || (probabilities[id] as number) < 0 || (probabilities[id] as number) > 1))) {
    forced = { status: 'fallback', code: 'invalid-response' };
  }
  const proposed = new Set(ids.filter(id => reasons[id]!.length));
  if (!forced) {
    for (const id of candidates) {
      if (input.decisions && input.decisions[id] == null) {
        proposed.add(id); reasons[id]!.push(input.observationError ?? 'observation-incomplete');
      } else if (input.decisions ? input.decisions[id] === true : (probabilities[id] as number) >= catalog.skip_below) {
        proposed.add(id); reasons[id]!.push('jev-at-or-above-threshold');
      } else reasons[id]!.push('jev-below-threshold');
    }
    closeDependencies(catalog, proposed, reasons);
  }
  const tasks: Record<string, TaskDecision> = {};
  const run: Record<string, boolean> = {};
  for (const id of ids) {
    const incomplete = candidates.some(candidate => input.decisions && input.decisions[candidate] == null);
    const effective = !!forced || incomplete || mode === 'shadow' || proposed.has(id);
    tasks[id] = {
      probability: !input.decisions && !forced && candidates.includes(id) ? probabilities[id] as number : null,
      proposed_run: forced || (input.decisions && candidates.includes(id) && input.decisions[id] == null && !reasons[id]!.includes('dependency')) ? null : proposed.has(id),
      run: effective,
      reasons: forced ? [...new Set([...reasons[id]!, forced.code])] : [...reasons[id]!],
    };
    if (mode === 'shadow') tasks[id]!.reasons.push('shadow-mode');
    run[id] = effective;
  }
  const selected = ids.filter(id => run[id]);
  return { mode, status: forced?.status ?? (candidates.some(id => input.decisions && input.decisions[id] == null) ? 'fallback' : 'planned'), tasks, run, selected,
    matrix: { include: selected.map(task => ({ task })) }, hasTasks: selected.length > 0 };
}
