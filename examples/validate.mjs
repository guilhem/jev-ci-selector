import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const example = resolve(process.argv[2] ?? 'examples/static-jobs');
const catalog = parse(readFileSync(resolve(example, '.github/task-routing.yaml'), 'utf8'));
const workflow = parse(readFileSync(resolve(example, '.github/workflows/ci.yml'), 'utf8'));
const tasks = Object.keys(catalog.tasks).sort();
const jobs = workflow.jobs;
for (const [id, task] of Object.entries(catalog.tasks)) {
  assert.ok(task.description.trim(), `${id}: description is required`);
  assert.ok(Array.isArray(task.jobs) && task.jobs.length > 0, `${id}: jobs must be nonempty`);
  for (const reference of task.jobs) {
    assert.equal(reference.workflow, '.github/workflows/ci.yml', `${id}: incorrect workflow reference`);
    if (reference.job) assert.ok(jobs[reference.job], `${id}: missing referenced job`);
  }
}
const gate = jobs['ci-required'];
const needs = Array.isArray(gate.needs) ? gate.needs : [gate.needs];
const expectedNeeds = gate.env.EXPECTED_NEEDS.split(',').filter(Boolean).sort();
const actualNeeds = needs.filter(Boolean).sort();
const set = (values) => [...values].sort();

assert.deepEqual(set(gate.env.EXPECTED_TASKS.split(',').filter(Boolean)), tasks, 'catalog and gate task IDs diverge');
assert.deepEqual(actualNeeds, expectedNeeds, 'gate needs and source declaration diverge');
assert.ok(jobs.plan.outputs.run && jobs.plan.outputs.selected && jobs.plan.outputs.matrix, 'plan outputs are incomplete');

if (!Object.hasOwn(jobs, 'tasks')) {
  assert.deepEqual(set(Object.keys(jobs).filter((id) => !['plan', 'ci-required'].includes(id))), tasks, 'static job IDs diverge');
  assert.deepEqual(actualNeeds, ['plan', ...tasks].sort(), 'gate must need every static job');
  assert.deepEqual(gate.env.EXPECTED_ALWAYS.split(',').filter(Boolean).sort(), tasks.filter(id => catalog.tasks[id].always === true), 'mandatory tasks diverge');
  for (const task of tasks) {
    const taskNeeds = Array.isArray(jobs[task].needs) ? jobs[task].needs : [jobs[task].needs];
    assert.ok(taskNeeds.includes('plan'), `${task} must need plan`);
    assert.equal(
      jobs.plan.outputs[task],
      `\${{ github.event_name == 'pull_request' && steps.select.outputs.${task} || steps.full.outputs.${task} }}`,
      `${task} must be published from the selector or full plan`,
    );
  }
} else {
  assert.deepEqual(actualNeeds, ['ci-contract', 'plan', 'tasks'], 'gate must need the contract validator, planner and matrix');
  assert.deepEqual(Object.keys(jobs).filter((id) => !['plan', 'ci-contract', 'ci-required'].includes(id)), ['tasks'], 'matrix launcher job is missing');
  assert.match(String(jobs.tasks.steps.find((step) => typeof step.run === 'string' && step.run.includes('case '))?.run), /unsupported task/);
  const launcher = String(jobs.tasks.steps.find((step) => typeof step.run === 'string' && step.run.includes('case '))?.run);
  for (const task of tasks) assert.match(launcher, new RegExp(`\\b${task}\\)`), `${task} is absent from launcher allowlist`);
  for (const task of tasks) assert.equal(catalog.tasks[task].jobs[0].job, 'tasks', `${task} must reference the matrix launcher`);
}

console.log(`validated ${example}: ${tasks.join(', ')}`);
