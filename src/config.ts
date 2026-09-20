import Ajv from 'ajv';
import { parseDocument } from 'yaml';
import schema from '../schemas/config.schema.json';

/** The compact policy representation consumed after metadata resolution. */
export interface Task {
  always?: boolean;
  force_paths?: string[];
  requires?: string[];
  question?: string;
}

export interface CatalogV1 {
  version: 1;
  model: string;
  skip_below: number;
  force_all_paths?: string[];
  tasks: Record<string, Task>;
}

/** Internal compiled catalog. Public YAML is represented by RoutingCatalog. */
export type Catalog = CatalogV1;

export interface JobReference {
  workflow: string;
  job?: string;
}

export interface RoutingTask {
  description: string;
  jobs: JobReference[];
  context_files?: string[];
  always?: boolean;
  force_paths?: string[];
}

export interface RoutingCatalog {
  model: string;
  skip_below: number;
  force_all_paths?: string[];
  tasks: Record<string, RoutingTask>;
}

export class ConfigError extends Error {
  constructor() { super('invalid-catalog'); }
}

const schemaValidator = new Ajv({ allErrors: true, strict: true }).compile<RoutingCatalog>(schema);
const reservedTaskIds = new Set(schema.definitions.taskId.not.enum.map(id => id.toLowerCase()));
const taskId = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const modelId = /^jev-[0-9]+\.[0-9]+\.[0-9]+$/;
const pathPattern = /^(?![!/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\u0000).+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && /\S/.test(value);
const validPaths = (value: unknown): value is string[] => Array.isArray(value) &&
  new Set(value).size === value.length && value.every(path => typeof path === 'string' && pathPattern.test(path));

function validateTaskIds(tasks: Record<string, unknown>): void {
  const outputIds = new Set<string>();
  for (const id of Object.keys(tasks)) {
    const outputId = id.toLowerCase();
    if (!taskId.test(id) || reservedTaskIds.has(outputId) || outputIds.has(outputId)) throw new ConfigError();
    outputIds.add(outputId);
  }
}

export function validateRoutingCatalog(value: unknown): asserts value is RoutingCatalog {
  if (!schemaValidator(value)) throw new ConfigError();
  const catalog = value;
  validateTaskIds(catalog.tasks);
}

/** Validate the compiled policy IR used by policy and Jev evaluation. */
export function validateCatalog(value: unknown): asserts value is Catalog {
  if (!isRecord(value) || value.version !== 1 || typeof value.model !== 'string' || !modelId.test(value.model) ||
    typeof value.skip_below !== 'number' || !Number.isFinite(value.skip_below) || value.skip_below < 0 || value.skip_below > 1 ||
    !isRecord(value.tasks) || (value.force_all_paths !== undefined && !validPaths(value.force_all_paths))) throw new ConfigError();
  validateTaskIds(value.tasks);
  for (const task of Object.values(value.tasks)) {
    if (!isRecord(task)) throw new ConfigError();
    const keys = Object.keys(task);
    if (keys.some(key => !['always', 'force_paths', 'requires', 'question'].includes(key))) throw new ConfigError();
    if (task.always !== undefined && typeof task.always !== 'boolean') throw new ConfigError();
    if (task.force_paths !== undefined && !validPaths(task.force_paths)) throw new ConfigError();
    if (task.requires !== undefined && (!Array.isArray(task.requires) || new Set(task.requires).size !== task.requires.length ||
      !task.requires.every(dependency => typeof dependency === 'string' && taskId.test(dependency)))) throw new ConfigError();
    if (task.question !== undefined && !nonEmptyString(task.question)) throw new ConfigError();
    if (task.always !== true && !nonEmptyString(task.question)) throw new ConfigError();
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const tasks = value.tasks;
  function visit(id: string): void {
    if (active.has(id) || !Object.hasOwn(tasks, id)) throw new ConfigError();
    if (visited.has(id)) return;
    active.add(id);
    const task = tasks[id];
    if (!isRecord(task)) throw new ConfigError();
    for (const dependency of (task.requires as string[] | undefined) ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  }
  for (const id of Object.keys(tasks)) visit(id);
}

export function parseCatalog(source: string): RoutingCatalog {
  try {
    const document = parseDocument(source, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new ConfigError();
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    validateRoutingCatalog(value);
    return value;
  } catch { throw new ConfigError(); }
}

export function validateConfigPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
    path.split('/').some(part => !part || part === '.' || part === '..')) throw new ConfigError();
}
