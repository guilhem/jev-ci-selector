import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { splitDiff } from '../../src/chunks.js';
import { buildQuestions } from '../../src/jev.js';
import { selectTasks } from '../../src/policy.js';
import { validateSelection, type SelectionDefinition } from '../../src/tasks.js';

const execFileAsync = promisify(execFile);

interface Label { relevance: 'relevant' | 'irrelevant' | 'unknown'; reason: string }
interface CorpusCase {
  id: string;
  split: 'calibration' | 'validation';
  diff: string;
  baseFiles: string;
  expected: Record<string, Label>;
  provenance: { kind: 'synthetic'; [key: string]: unknown };
}
interface Corpus { version: 1; cases: CorpusCase[] }
interface MockChoiceCase {
  name: string;
  choices: Record<string, 'required' | 'independent' | 'unresolved'>;
  coverage: Record<string, boolean>;
  changedPaths: string[];
  expectedRun: Record<string, boolean>;
}

export async function inspectCorpus(root: string): Promise<{ cases: number; tasks: number }> {
  const selection: unknown = JSON.parse(await readFile(join(root, 'selection.json'), 'utf8'));
  validateSelection(selection);
  const corpus = JSON.parse(await readFile(join(root, 'corpus.json'), 'utf8')) as Corpus;
  assert.equal(corpus.version, 1);
  assert.equal(corpus.cases.length, 8);
  assert.equal(new Set(corpus.cases.map(item => item.id)).size, corpus.cases.length);
  assert.deepEqual(new Set(corpus.cases.map(item => item.split)), new Set(['calibration', 'validation']));
  const taskIds = Object.keys(selection.tasks).sort();
  const questions = buildQuestions(selection, taskIds);
  for (const id of taskIds) {
    const instructions = questions[id]!.instructions;
    if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) throw new Error('invalid-question-instructions');
    assert.deepEqual(instructions.task, { description: selection.tasks[id]!.description });
    assert.deepEqual(Object.keys(questions[id]!.criteria).sort(), ['independent', 'required', 'unresolved']);
  }
  for (const item of corpus.cases) {
    assert.equal(item.provenance.kind, 'synthetic');
    assert.deepEqual(Object.keys(item.expected).sort(), taskIds);
    for (const label of Object.values(item.expected)) assert.ok(label.reason.trim());
    const diffPath = resolve(root, item.diff);
    const basePath = resolve(root, item.baseFiles);
    assert.ok(diffPath.startsWith(`${resolve(root)}${sep}`) && basePath.startsWith(`${resolve(root)}${sep}`));
    const diff = await readFile(diffPath, 'utf8');
    assert.ok(splitDiff(diff, Buffer.byteLength(diff)).flatMap(group => group.paths).length, item.id);
    await execFileAsync('git', ['apply', '--check', diffPath], { cwd: basePath });
  }
  return { cases: corpus.cases.length, tasks: taskIds.length };
}

export async function replayMockChoices(root: string): Promise<{ checked: number; stale: number }> {
  const selection = JSON.parse(await readFile(join(root, 'selection.json'), 'utf8')) as SelectionDefinition;
  validateSelection(selection);
  const recording = JSON.parse(await readFile(join(root, 'recordings', 'mock-choice.json'), 'utf8')) as { provenance: string; cases: MockChoiceCase[] };
  assert.equal(recording.provenance, 'self-authored deterministic mock; no provider inference');
  assert.ok(recording.cases.length > 0);
  for (const item of recording.cases) {
    const decisions = Object.fromEntries(Object.entries(item.choices).map(([id, choice]) => {
      assert.ok(['required', 'independent', 'unresolved'].includes(choice), item.name);
      return [id, choice === 'required' ? true : choice === 'independent' ? false : null];
    }));
    const plan = selectTasks({ selection, changedPaths: item.changedPaths, decisions, coverage: item.coverage, mode: 'enforce' });
    assert.deepEqual(plan.run, item.expectedRun, item.name);
    for (const [id, run] of Object.entries(plan.run)) {
      if (!run) {
        assert.equal(item.choices[id], 'independent', item.name);
        assert.equal(item.coverage[id], true, item.name);
      }
    }
  }
  return { checked: recording.cases.length, stale: 0 };
}
