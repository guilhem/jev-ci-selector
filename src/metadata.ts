import { createHash } from 'node:crypto';
import { LineCounter, parseDocument } from 'yaml';
import { validateResolvedSelection, validateSelection, type ResolvedSelection, type JobReference, type SelectionDefinition, type ResolvedTask, type TaskEvidence } from './tasks.js';
import { InputError } from './input-error.js';

export interface SourceLocation {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface SourceLocator {
  repository: string;
  commit: string;
  file: string;
  location: SourceLocation;
}

export interface MetadataProvenance {
  kind: string;
  locator: SourceLocator;
  sha256: string;
  resolvedSha?: string;
}

export interface TaskMetadata {
  workflow?: string;
  job?: string;
  incomplete: boolean;
  missing: string[];
  provenance: MetadataProvenance[];
  hashes: Record<string, string>;
  warnings: string[];
  nativeDependencies: string[];
}

export interface SelectionMetadata {
  repository: string;
  commit: string;
  tasks: Record<string, TaskMetadata>;
}

export interface ExternalResolutionRequest {
  repository: string;
  commit: string;
  uses: string;
  path: string;
  ref: string;
}

export interface ExternalResolution {
  repository: string;
  commit: string;
  file: string;
  content: string | Uint8Array;
  sha: string;
}

export interface ResolveTasksOptions {
  repository: string;
  commit: string;
  readFile: (commit: string, file: string) => Promise<string | Uint8Array> | string | Uint8Array;
  resolveExternal?: (request: ExternalResolutionRequest) => Promise<ExternalResolution | null> | ExternalResolution | null;
}

export interface ResolveTasksResult {
  selection: ResolvedSelection;
  metadata: SelectionMetadata;
  workingDirectories: string[];
}

type AnyRecord = Record<string, any>;
type ParsedYaml = { value: unknown; document: any; lineCounter: LineCounter; source: string };
type FileSource = { repository: string; commit: string; file: string; source: string; sha256: string; document?: ParsedYaml };

const MAX_SCRIPT_DEPTH = 16;

const text = (value: string | Uint8Array): string => typeof value === 'string'
  ? value
  : new TextDecoder('utf-8', { fatal: true }).decode(value);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is AnyRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0') ||
    normalized.split('/').some(part => !part || part === '..')) throw new InputError('tasks');
  return normalized;
}

function locationFor(node: any, lineCounter: LineCounter, source: string): SourceLocation {
  const range = Array.isArray(node?.range) ? node.range : [0, source.length];
  const start = lineCounter.linePos(range[0] ?? 0);
  const endOffset = Math.max(range[0] ?? 0, (range[2] ?? range[1] ?? source.length) - 1);
  const end = lineCounter.linePos(endOffset);
  return { line: start.line || 1, column: start.col || 1, endLine: end.line || 1, endColumn: end.col || 1 };
}

function locator(source: FileSource, node?: any): SourceLocator {
  const parsed = source.document;
  return {
    repository: source.repository,
    commit: source.commit,
    file: source.file,
    location: parsed ? locationFor(node, parsed.lineCounter, parsed.source) : { line: 1, column: 1, endLine: 1, endColumn: 1 },
  };
}

function parseYaml(source: FileSource): ParsedYaml {
  const lineCounter = new LineCounter();
  const document = parseDocument(source.source, { uniqueKeys: true, strict: true, lineCounter, keepSourceTokens: true });
  if (document.errors.length || document.warnings.length) throw new Error('invalid-yaml');
  const parsed = { value: document.toJS({ maxAliasCount: 0 }), document, lineCounter, source: source.source };
  source.document = parsed;
  return parsed;
}

function pairIn(node: any, key: string): any | undefined {
  if (!node || !Array.isArray(node.items)) return undefined;
  return node.items.find((pair: any) => asString(pair?.key?.value) === key);
}

function valueNode(node: any, key: string): any | undefined {
  return pairIn(node, key)?.value;
}

function mapEntries(node: any): Array<{ key: string; pair: any; value: any }> {
  if (!node || !Array.isArray(node.items)) return [];
  return node.items.flatMap((pair: any) => {
    const key = asString(pair?.key?.value);
    return key === undefined ? [] : [{ key, pair, value: pair.value }];
  });
}

function nodeAtPath(node: any, path: string[]): any | undefined {
  let current = node;
  for (const key of path) current = valueNode(current, key);
  return current;
}

function objectAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function newTaskMetadata(): TaskMetadata {
  return { incomplete: false, missing: [], provenance: [], hashes: {}, warnings: [], nativeDependencies: [] };
}

function warning(metadata: TaskMetadata, message: string, missing = true): void {
  if (!metadata.warnings.includes(message)) metadata.warnings.push(message);
  if (missing && !metadata.missing.includes(message)) metadata.missing.push(message);
  if (missing) metadata.incomplete = true;
}

function addSource(metadata: TaskMetadata, source: FileSource, kind: string, node?: any, _hashKey = kind, resolvedSha?: string): void {
  const sourceHash = source.sha256;
  metadata.hashes[`source:${source.repository}@${source.commit}:${source.file}`] = sourceHash;
  const item: MetadataProvenance = { kind, locator: locator(source, node), sha256: sourceHash };
  if (resolvedSha) item.resolvedSha = resolvedSha;
  const identity = `${item.kind}\0${item.locator.repository}\0${item.locator.commit}\0${item.locator.file}\0${item.locator.location.line}\0${item.locator.location.column}`;
  if (!metadata.provenance.some(existing => `${existing.kind}\0${existing.locator.repository}\0${existing.locator.commit}\0${existing.locator.file}\0${existing.locator.location.line}\0${existing.locator.location.column}` === identity)) {
    metadata.provenance.push(item);
  }
}

function addWholeFileSource(metadata: TaskMetadata, source: FileSource, kind: string, hashKey = kind): void {
  addSource(metadata, source, kind, undefined, hashKey);
}

function findTextLocation(source: FileSource, needle: string): SourceLocation {
  const offset = source.source.indexOf(needle);
  if (offset < 0) return { line: 1, column: 1, endLine: 1, endColumn: 1 };
  const line = source.source.slice(0, offset).split('\n').length;
  const lastNewline = source.source.lastIndexOf('\n', offset - 1);
  const column = offset - lastNewline;
  const endOffset = offset + needle.length;
  const endLine = source.source.slice(0, endOffset).split('\n').length;
  const endLastNewline = source.source.lastIndexOf('\n', endOffset - 1);
  return { line, column, endLine, endColumn: endOffset - endLastNewline };
}

function addJsonPropertySource(metadata: TaskMetadata, source: FileSource, kind: string, property: string, _hashKey: string): void {
  metadata.hashes[`source:${source.repository}@${source.commit}:${source.file}`] = source.sha256;
  const item: MetadataProvenance = { kind, locator: { ...locator(source), location: findTextLocation(source, `"${property}"`) }, sha256: source.sha256 };
  const identity = `${item.kind}\0${item.locator.file}\0${item.locator.location.line}\0${item.locator.location.column}`;
  if (!metadata.provenance.some(existing => `${existing.kind}\0${existing.locator.file}\0${existing.locator.location.line}\0${existing.locator.location.column}` === identity)) metadata.provenance.push(item);
}

function needsOf(value: unknown): string[] {
  return typeof value === 'string' ? [value] : asStrings(value);
}

function workingDirectoryValues(workflow: AnyRecord, job: AnyRecord): string[] {
  const result: string[] = [];
  const add = (value: unknown) => { if (typeof value === 'string' && !result.includes(value)) result.push(value); };
  add(objectAtPath(workflow, ['defaults', 'run', 'working-directory']));
  add(objectAtPath(job, ['defaults', 'run', 'working-directory']));
  const workflowDirectory = asString(objectAtPath(workflow, ['defaults', 'run', 'working-directory'])) ?? '.';
  const jobDirectory = asString(objectAtPath(job, ['defaults', 'run', 'working-directory'])) ?? workflowDirectory;
  for (const step of Array.isArray(job.steps) ? job.steps : []) if (isRecord(step)) add(step['working-directory'] ?? jobDirectory);
  return result;
}

function scriptReferences(command: string): string[] {
  const refs: string[] = [];
  const ignored = new Set(['install', 'ci', 'add', 'remove', 'update', 'publish', 'pack', 'exec', 'dlx', 'config', 'init', 'version']);
  const patterns = [
    /\b(?:npm|pnpm|yarn)\s+(?:(?:run|exec)\s+)?([A-Za-z0-9][A-Za-z0-9:_-]*)/g,
    /\bbun\s+run\s+([A-Za-z0-9][A-Za-z0-9:_-]*)/g,
  ];
  for (const pattern of patterns) for (const match of command.matchAll(pattern)) {
    const name = match[1]!;
    const after = command[(match.index ?? 0) + match[0].length];
    if (after === '/' || after === '.') continue;
    if (!ignored.has(name) && !refs.includes(name)) refs.push(name);
  }
  return refs;
}

function packagePath(workingDirectory: string): string | undefined {
  if (workingDirectory.includes('${{') || workingDirectory.includes('}}')) return undefined;
  try { return `${normalizePath(workingDirectory || '.')}/package.json`.replace(/^\.\//, ''); }
  catch { return undefined; }
}

interface ActionSummary {
  uses: string;
  name?: string;
  description?: string;
  inputs?: Record<string, string>;
}

type PackageCommand = { command: string; workingDirectory: string };

function actionReference(uses: string): { external: boolean; repository?: string; path: string; ref?: string } | null {
  if (uses.startsWith('./')) return { external: false, path: normalizePath(uses.slice(2)) };
  if (uses.startsWith('docker://')) return null;
  const at = uses.lastIndexOf('@');
  if (at <= 0 || at === uses.length - 1) return null;
  const coordinate = uses.slice(0, at).split('/');
  if (coordinate.length < 2) return null;
  const repository = coordinate.slice(0, 2).join('/');
  const path = coordinate.slice(2).join('/') || '.';
  return { external: true, repository, path, ref: uses.slice(at + 1) };
}

async function readLocal(options: ResolveTasksOptions, cache: Map<string, FileSource | null>, repository: string, commit: string, file: string): Promise<FileSource | null> {
  const normalized = normalizePath(file);
  const key = `${repository}\0${commit}\0${normalized}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const source = text(await options.readFile(commit, normalized));
    const result: FileSource = { repository, commit, file: normalized, source, sha256: sha256(source) };
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function readAction(options: ResolveTasksOptions, cache: Map<string, FileSource | null>, uses: string, metadata: TaskMetadata, summaries: ActionSummary[], suppliedInputs: AnyRecord = {}): Promise<ActionSummary | null> {
  const reference = actionReference(uses);
  if (!reference) {
    warning(metadata, `action-metadata-unavailable:${uses}`);
    return null;
  }
  let actionSource: FileSource | null = null;
  let resolvedSha: string | undefined;
  if (!reference.external) {
    const actionPath = reference.path;
    for (const candidate of [`${actionPath}/action.yml`, `${actionPath}/action.yaml`]) {
      // ./ paths are relative to the caller workspace, including inside an
      // external composite. They are not relative to the action repository.
      actionSource = await readLocal(options, cache, options.repository, options.commit, candidate);
      if (actionSource) break;
    }
  } else if (options.resolveExternal) {
    const request: ExternalResolutionRequest = {
      repository: reference.repository!, commit: options.commit, uses, path: reference.path, ref: reference.ref!,
    };
    try {
      const resolved = await options.resolveExternal(request);
      if (resolved) {
        const sourceText = text(resolved.content);
        actionSource = { repository: resolved.repository, commit: resolved.commit, file: normalizePath(resolved.file), source: sourceText, sha256: sha256(sourceText) };
        resolvedSha = resolved.sha;
      }
    } catch {
      actionSource = null;
    }
  }
  if (!actionSource) {
    warning(metadata, `action-metadata-missing:${uses}`);
    return null;
  }
  let parsed: ParsedYaml;
  try { parsed = parseYaml(actionSource); }
  catch {
    warning(metadata, `action-metadata-invalid:${uses}`);
    return null;
  }
  addSource(metadata, actionSource, 'action', parsed.document.contents, `action:${uses}`, resolvedSha);
  const value = isRecord(parsed.value) ? parsed.value : {};
  const declaredInputs = isRecord(value.inputs) ? value.inputs : undefined;
  const inputDescriptions = declaredInputs
    ? Object.fromEntries(Object.keys(suppliedInputs).sort().flatMap(name => {
      const input = declaredInputs[name];
      return isRecord(input) && typeof input.description === 'string' ? [[name, input.description]] : [];
    }))
    : {};
  const summary: ActionSummary = {
    uses,
    ...(asString(value.name) ? { name: value.name } : {}),
    ...(asString(value.description) ? { description: value.description } : {}),
    ...(Object.keys(inputDescriptions).length ? { inputs: inputDescriptions } : {}),
  };
  summaries.push(summary);
  return summary;
}

async function readPackageScripts(options: ResolveTasksOptions, cache: Map<string, FileSource | null>, metadata: TaskMetadata, commands: PackageCommand[]): Promise<unknown[]> {
  const resolved: unknown[] = [];
  const visited = new Set<string>();
  const references = (command: string): string[] => {
    const names = scriptReferences(command);
    // Do not simulate a shell or attribute commands after a directory/workspace
    // switch to the initial manifest. Preserve the native command and retain the
    // job explicitly when script execution context cannot be established.
    if (/\b(?:npm|pnpm|yarn|bun)\b/.test(command) && (/(?:^|[\s;&|()])(?:cd|pushd|popd)\s/.test(command) ||
      /(?:^|\s)(?:--(?:prefix|cwd|dir|workspace|workspaces|filter)(?:[=\s]|$)|-[Cw](?:\s|$))/.test(command))) {
      warning(metadata, 'package-script-execution-context-unresolved');
      return [];
    }
    return names;
  };
  const visit = async (name: string, workingDirectory: string, depth: number): Promise<void> => {
    if (depth >= MAX_SCRIPT_DEPTH) { warning(metadata, `package-script-depth-limit:${name}`); return; }
    const manifest = packagePath(workingDirectory);
    if (!manifest) { warning(metadata, `package-script-dynamic-directory:${workingDirectory}`); return; }
    const key = `${manifest}\0${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const source = await readLocal(options, cache, options.repository, options.commit, manifest);
    if (!source) { warning(metadata, `package-script-missing:${manifest}#${name}`); return; }
    let packageJson: AnyRecord;
    try {
      const parsed: unknown = JSON.parse(source.source);
      if (!isRecord(parsed)) throw new Error();
      packageJson = parsed;
    } catch { warning(metadata, `package-manifest-invalid:${manifest}`); return; }
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    const command = asString(scripts[name]);
    if (command === undefined) { warning(metadata, `package-script-absent:${manifest}#${name}`); return; }
    addJsonPropertySource(metadata, source, 'package-script', name, `package:${manifest}#${name}`);
    resolved.push({ name, command, workingDirectory, manifest });
    for (const nested of references(command)) await visit(nested, workingDirectory, depth + 1);
  };
  for (const item of commands) for (const name of references(item.command)) await visit(name, item.workingDirectory, 0);
  return resolved;
}

function contextFilePath(path: string): string | undefined {
  if (path.includes('${{') || path.includes('}}')) return undefined;
  try { return normalizePath(path); } catch { return undefined; }
}

type JobRecord = { reference: JobReference; workflow: FileSource; parsed: ParsedYaml; jobId: string; job: AnyRecord; jobNode: any };
type WorkflowEntry = { source: FileSource | null; parsed: ParsedYaml | null };

function effectiveStep(step: AnyRecord, workflow: AnyRecord, job: AnyRecord): AnyRecord {
  const workflowRun = isRecord(workflow.defaults) && isRecord(workflow.defaults.run) ? workflow.defaults.run : {};
  const jobRun = isRecord(job.defaults) && isRecord(job.defaults.run) ? job.defaults.run : {};
  const workingDirectory = asString(step['working-directory']) ?? asString(jobRun['working-directory']) ?? asString(workflowRun['working-directory']) ?? '.';
  const shell = asString(step.shell) ?? asString(jobRun.shell) ?? asString(workflowRun.shell);
  return { ...step, workingDirectory, ...(shell ? { shell } : {}) };
}

function compactStep(step: AnyRecord, workflow: AnyRecord, job: AnyRecord): Record<string, unknown> {
  const resolved = effectiveStep(step, workflow, job);
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'run', 'uses', 'with']) if (resolved[key] !== undefined) result[key === 'working-directory' ? 'working_directory' : key] = resolved[key];
  result.working_directory = resolved.workingDirectory;
  if (resolved.shell !== undefined) result.shell = resolved.shell;
  return result;
}

function compactJob(jobId: string, job: AnyRecord, workflow: AnyRecord): Record<string, unknown> {
  const result: Record<string, unknown> = { id: jobId };
  if (typeof job.name === 'string') result.name = job.name;
  if (typeof job.uses === 'string') result.uses = job.uses;
  if (Array.isArray(job.steps)) result.steps = job.steps.filter(isRecord).map(step => compactStep(step, workflow, job));
  return result;
}

export async function resolveTasks(selection: SelectionDefinition, options: ResolveTasksOptions): Promise<ResolveTasksResult> {
  const metadata: SelectionMetadata = { repository: options.repository, commit: options.commit, tasks: {} };
  validateSelection(selection);
  const cache = new Map<string, FileSource | null>();
  const workflows = new Map<string, WorkflowEntry>();
  const selected = Object.entries(selection.tasks).map(([id, task]) => ({ id, task }));
  const records = new Map<string, JobRecord[]>();
  const workingDirectories: string[] = [];
  const addWorkingDirectories = (values: string[]) => values.forEach(value => { if (!workingDirectories.includes(value)) workingDirectories.push(value); });

  async function workflowFor(reference: JobReference): Promise<WorkflowEntry> {
    let entry = workflows.get(reference.workflow);
    if (entry) return entry;
    let source: FileSource | null = null;
    try { source = await readLocal(options, cache, options.repository, options.commit, reference.workflow); } catch { source = null; }
    let parsed: ParsedYaml | null = null;
    if (source) {
      try { parsed = parseYaml(source); } catch { parsed = null; }
    }
    entry = { source, parsed };
    workflows.set(reference.workflow, entry);
    return entry;
  }

  for (const { id, task } of selected) {
    const taskMetadata = newTaskMetadata();
    const uniqueReferences = new Map<string, JobReference>();
    for (const reference of task.jobs ?? []) uniqueReferences.set(`${reference.workflow}\0${reference.job ?? ''}`, reference);
    const taskRecords: JobRecord[] = [];
    const seenJobs = new Set<string>();
    for (const reference of uniqueReferences.values()) {
      if (metadata.tasks[id] === undefined) metadata.tasks[id] = taskMetadata;
      taskMetadata.workflow ??= reference.workflow;
      if (task.jobs?.length === 1 && reference.job) taskMetadata.job = reference.job;
      const entry = await workflowFor(reference);
      if (!entry.source || !entry.parsed || !isRecord(entry.parsed.value)) {
        warning(taskMetadata, entry.source ? `workflow-invalid:${reference.workflow}` : `workflow-missing:${reference.workflow}`);
        continue;
      }
      const workflow = entry.parsed.value as AnyRecord;
      const jobsValue = isRecord(workflow.jobs) ? workflow.jobs : {};
      const jobsNode = valueNode(entry.parsed.document.contents, 'jobs');
      const candidates = reference.job
        ? [{ jobId: reference.job, job: jobsValue[reference.job], jobPair: pairIn(jobsNode, reference.job) }]
        : mapEntries(jobsNode).map(({ key, value, pair }) => ({ jobId: key, job: jobsValue[key], jobPair: pair }));
      if (!candidates.length) {
        warning(taskMetadata, reference.job ? `job-missing:${reference.workflow}#${reference.job}` : `workflow-jobs-missing:${reference.workflow}`);
        continue;
      }
      for (const candidate of candidates) {
        if (!isRecord(candidate.job) || !candidate.jobPair) {
          warning(taskMetadata, `job-missing:${reference.workflow}#${candidate.jobId}`);
          continue;
        }
        const key = `${reference.workflow}\0${candidate.jobId}`;
        if (seenJobs.has(key)) continue;
        seenJobs.add(key);
        const record: JobRecord = { reference: { workflow: reference.workflow, job: candidate.jobId }, workflow: entry.source, parsed: entry.parsed, jobId: candidate.jobId, job: candidate.job, jobNode: candidate.jobPair.value };
        taskRecords.push(record);
        addSource(taskMetadata, entry.source, 'workflow-job', candidate.jobPair.value, `workflow-job:${key}`);
        addWorkingDirectories(workingDirectoryValues(workflow, candidate.job));
      }
    }
    records.set(id, taskRecords);
    metadata.tasks[id] = taskMetadata;
  }

  const resolvedTasks: Record<string, ResolvedTask> = {};
  for (const { id, task } of selected) {
    const taskMetadata = metadata.tasks[id]!;
    const taskRecords = records.get(id) ?? [];
    const actions: ActionSummary[] = [];
    const actionsByUses = new Map<string, AnyRecord>();
    const packageCommands: PackageCommand[] = [];
    const contextFiles: Array<{ path: string; content: string }> = [];
    const jobs: Record<string, unknown>[] = [];
    const nativeDependencies = new Set<string>();
    for (const record of taskRecords) {
      const workflow = record.parsed.value as AnyRecord;
      if (isRecord(workflow.defaults) && isRecord(workflow.defaults.run)) {
        addSource(taskMetadata, record.workflow, 'workflow-defaults', valueNode(record.parsed.document.contents, 'defaults'));
      }
      if (isRecord(record.job.defaults) && isRecord(record.job.defaults.run)) {
        addSource(taskMetadata, record.workflow, 'job-defaults', valueNode(record.jobNode, 'defaults'));
      }
      if (typeof record.job.uses === 'string') warning(taskMetadata, `reusable-workflow-unresolved:${record.job.uses}`);
      for (const need of needsOf(record.job.needs)) nativeDependencies.add(need);
      const steps = Array.isArray(record.job.steps) ? record.job.steps : [];
      const stepsNode = valueNode(record.jobNode, 'steps');
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (!isRecord(step)) continue;
        const stepNode = Array.isArray(stepsNode?.items) ? stepsNode.items[index] : undefined;
        addSource(taskMetadata, record.workflow, 'workflow-step', stepNode, `workflow-step:${record.jobId}:${index}`);
        const resolved = effectiveStep(step, workflow, record.job);
        const command = asString(step.run);
        if (command) packageCommands.push({ command, workingDirectory: asString(resolved.workingDirectory) ?? '.' });
        if (typeof step.uses === 'string') {
          actionsByUses.set(step.uses, { ...actionsByUses.get(step.uses), ...(isRecord(step.with) ? step.with : {}) });
        }
      }
      jobs.push({ workflow: record.reference.workflow, ...compactJob(record.jobId, record.job, workflow) });
    }
    for (const [uses, inputs] of actionsByUses) {
      await readAction(options, cache, uses, taskMetadata, actions, inputs);
    }
    taskMetadata.nativeDependencies = [...nativeDependencies].sort();
    const scripts = await readPackageScripts(options, cache, taskMetadata, packageCommands);
    addWorkingDirectories(packageCommands.map(item => item.workingDirectory).filter(directory => directory !== '.'));
    for (const path of task.context_files ?? []) {
      const normalized = contextFilePath(path);
      if (!normalized) { warning(taskMetadata, `context-file-dynamic:${path}`); continue; }
      const source = await readLocal(options, cache, options.repository, options.commit, normalized);
      if (!source) { warning(taskMetadata, `context-file-missing:${normalized}`); continue; }
      addWholeFileSource(taskMetadata, source, 'context-file', `context:${normalized}`);
      contextFiles.push({ path, content: source.source });
    }
    const evidence = {
      description: task.description,
      jobs,
      actions,
      packageScripts: scripts,
      contextFiles,
      ...(taskMetadata.incomplete ? { incomplete: true } : {}),
    };
    resolvedTasks[id] = {
      ...(task.always || taskMetadata.incomplete ? { always: true } : {}),
      ...(task.force_paths ? { force_paths: [...task.force_paths] } : {}),
      evidence: stable(evidence) as TaskEvidence,
    };
  }
  const resolved: ResolvedSelection = { model: selection.model, skip_below: selection.skip_below, tasks: resolvedTasks };
  validateResolvedSelection(resolved);
  return { selection: resolved, metadata, workingDirectories };
}
