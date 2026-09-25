import Ajv from 'ajv';
import { parseDocument } from 'yaml';
import { createHash } from 'node:crypto';
import schema from '../schemas/tasks.schema.json';
import { InputError } from './input-error.js';

export interface TaskDefinition {
  description: string;
  always?: boolean;
  force_paths?: string[];
}
export type TaskDefinitions = Record<string, TaskDefinition>;
export interface SelectionDefinition { model: string; tasks: TaskDefinitions }

const validateSchema = new Ajv({ allErrors: true, strict: true }).compile<TaskDefinitions>(schema);
const reservedIds = new Set(schema.definitions.taskId.not.enum.map(id => id.toLowerCase()));
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validateIds(tasks: Record<string, unknown>): void {
  const ids = new Set<string>();
  for (const id of Object.keys(tasks)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(id) || reservedIds.has(id.toLowerCase()) || ids.has(id.toLowerCase())) throw new InputError('tasks');
    ids.add(id.toLowerCase());
  }
}

export function validateTasks(value: unknown): asserts value is TaskDefinitions {
  if (!validateSchema(value)) throw new InputError('tasks');
  validateIds(value);
}

function validateSettings(value: Record<string, unknown>): void {
  if (typeof value.model !== 'string' || !/^jev-[0-9]+\.[0-9]+\.[0-9]+(?![\s\S])/.test(value.model)) throw new InputError('model');
}

export function validateSelection(value: unknown): asserts value is SelectionDefinition {
  if (!record(value) || Object.keys(value).some(key => !['model', 'tasks'].includes(key))) throw new InputError('tasks');
  validateSettings(value);
  validateTasks(value.tasks);
}

export function parseTasks(source: string): TaskDefinitions {
  try {
    if (!source.trim()) throw new InputError('tasks');
    const document = parseDocument(source, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new InputError('tasks');
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    validateTasks(value);
    return Object.fromEntries(Object.entries(value).map(([id, task]) => [id, { ...task, always: task.always ?? false }]));
  } catch { throw new InputError('tasks'); }
}

export function parseSelectionInputs(getInput: (name: string) => string): SelectionDefinition {
  const model = getInput('model').trim() || 'jev-1.13.0';
  const selection = { model, tasks: parseTasks(getInput('tasks')) };
  validateSelection(selection);
  return selection;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function selectionHash(selection: SelectionDefinition): string {
  const tasks = Object.fromEntries(Object.entries(selection.tasks).map(([id, task]) => [id, { ...task, always: task.always ?? false }]));
  return createHash('sha256').update(JSON.stringify(canonical({ model: selection.model, tasks }))).digest('hex');
}
