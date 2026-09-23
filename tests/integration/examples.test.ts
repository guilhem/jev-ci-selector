import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { parse as parseYaml } from 'yaml';
import { parseTasks } from '../../src/tasks.js';

const root = process.cwd();
const examples = ['static-jobs', 'matrix'] as const;
const taskIds = (tasks: ReturnType<typeof parseTasks>): string[] => Object.keys(tasks).sort();
const readTasks = (name: string): ReturnType<typeof parseTasks> => {
  const workflow = name === 'shadow'
    ? parseYaml(readFileSync(resolve(root, 'examples/shadow/.github/workflows/observe.yml'), 'utf8'))
    : readWorkflow(name);
  const job = workflow.jobs[name === 'shadow' ? 'observe' : 'plan'];
  return parseTasks(job.steps.find((step: Record<string, any>) => step.id === 'select').with.tasks);
};
const readWorkflow = (name: string): Record<string, any> => parseYaml(
  readFileSync(resolve(root, 'examples', name, '.github/workflows/ci.yml'), 'utf8'),
);

function assertReportUpload(workflow: Record<string, any>, job: Record<string, any>): void {
  const uploads = job.steps.filter((step: Record<string, any>) => String(step.uses).startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 1);
  const upload = uploads[0];
  assert.equal(upload.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  assert.equal(upload.if, "${{ always() && steps.select.outcome == 'success' }}");
  assert.equal(upload['continue-on-error'], true);
  assert.deepEqual(upload.with, {
    name: 'jev-plan-report-${{ github.run_id }}-${{ github.run_attempt }}',
    path: '${{ steps.select.outputs.report-path }}',
    'retention-days': 14,
    'if-no-files-found': 'error',
  });
  for (const candidate of Object.values(workflow.jobs) as Array<Record<string, any>>) {
    assert.equal(candidate['continue-on-error'], undefined);
    for (const step of candidate.steps) {
      if (step !== upload) assert.equal(step['continue-on-error'], undefined);
    }
  }
}

function gateScript(workflow: Record<string, any>): string {
  const steps = workflow.jobs['ci-required'].steps as Array<Record<string, unknown>>;
  const step = steps.find((candidate) => typeof candidate.run === 'string' && candidate.run.includes('node <<'));
  assert.ok(step && typeof step.run === 'string', 'ci-required must execute its inline gate');
  return step.run;
}

function planEnv(tasks: string[], selected: string[], result: string = 'success') {
  const run = Object.fromEntries(tasks.map((task) => [task, selected.includes(task)]));
  const matrix = { include: selected.map((task) => ({ task })) };
  const needs: Record<string, { result: string; outputs?: Record<string, string> }> = {
    plan: { result, outputs: Object.fromEntries(tasks.map(task => [task, String(run[task])])) },
  };
  for (const task of tasks) needs[task] = { result: selected.includes(task) ? 'success' : 'skipped' };
  return {
    EXPECTED_TASKS: tasks.join(','),
    EXPECTED_DEPENDENCIES: 'e2e_network=build;e2e_upgrade=build',
    EXPECTED_ALWAYS: 'build,lint,unit',
    EXPECTED_NEEDS: ['plan', ...tasks].join(','),
    PLAN_RESULT: result,
    PLAN_RUN: JSON.stringify(run),
    PLAN_SELECTED: JSON.stringify(selected),
    PLAN_MATRIX: JSON.stringify(matrix),
    PLAN_HAS_TASKS: selected.length > 0 ? 'true' : 'false',
    PLAN_STATUS: 'planned',
    PLAN_TESTED_SHA: 'a'.repeat(40),
    EXPECTED_TESTED_SHA: 'a'.repeat(40),
    NEEDS_JSON: JSON.stringify(needs),
  };
}

function matrixEnv(tasks: string[], selected: string[], matrixResult: string = 'success') {
  const run = Object.fromEntries(tasks.map((task) => [task, selected.includes(task)]));
  const matrix = { include: selected.map((task) => ({ task })) };
  return {
    EXPECTED_TASKS: tasks.join(','),
    EXPECTED_NEEDS: 'plan,tasks',
    PLAN_RESULT: 'success',
    PLAN_RUN: JSON.stringify(run),
    PLAN_SELECTED: JSON.stringify(selected),
    PLAN_MATRIX: JSON.stringify(matrix),
    PLAN_HAS_TASKS: selected.length > 0 ? 'true' : 'false',
    PLAN_STATUS: 'planned',
    PLAN_TESTED_SHA: 'a'.repeat(40),
    EXPECTED_TESTED_SHA: 'a'.repeat(40),
    NEEDS_JSON: JSON.stringify({ plan: { result: 'success' }, tasks: { result: matrixResult } }),
  };
}

function runGate(workflow: Record<string, any>, env: Record<string, string>): { status: number | null; output: string } {
  const shell = gateScript(workflow);
  const marker = "node <<'NODE'\n";
  const start = shell.indexOf(marker);
  assert.notEqual(start, -1, 'gate must contain a Node heredoc');
  const codeStart = start + marker.length;
  const end = shell.indexOf('\nNODE', codeStart);
  assert.notEqual(end, -1, 'gate Node heredoc must be terminated');
  const contextProcess = { env: { ...process.env, ...env }, exitCode: 0 };
  const messages: string[] = [];
  try {
    vm.runInNewContext(codeSlice(shell, codeStart, end), {
      process: contextProcess,
      console: { error: (...parts: unknown[]) => messages.push(parts.join(' ')) },
    });
  } catch (error) {
    messages.push(error instanceof Error ? error.message : String(error));
    contextProcess.exitCode = 1;
  }
  return { status: contextProcess.exitCode, output: messages.join('\n') };
}

function codeSlice(source: string, start: number, end: number): string {
  return source.slice(start, end);
}

test('example tasks and workflow job IDs have one stable contract', () => {
  for (const name of examples) {
    const definitions = readTasks(name);
    const workflow = readWorkflow(name);
    const tasks = taskIds(definitions);
    const jobs = workflow.jobs as Record<string, any>;
    const finalNeeds = (Array.isArray(jobs['ci-required'].needs) ? jobs['ci-required'].needs : [jobs['ci-required'].needs]).sort();
    assert.deepEqual(jobs['ci-required'].env.EXPECTED_TASKS.split(',').sort(), tasks);
    assert.match(jobs['ci-required'].env.EXPECTED_NEEDS, /plan/);
    assert.equal(jobs['ci-required'].if, '${{ always() }}');
    assert.ok(jobs.plan.outputs.run && jobs.plan.outputs.selected && jobs.plan.outputs.matrix);
    assert.ok(jobs.plan.outputs['has-tasks'] && jobs.plan.outputs['tested-sha']);
    assert.ok(jobs.plan.steps.every((step: Record<string, unknown>) => !('uses' in step && String(step.uses).startsWith('actions/checkout@'))), 'planning must not checkout PR code');
    const selector = jobs.plan.steps.find((step: Record<string, unknown>) => step.id === 'select') as Record<string, any>;
    assert.equal(selector.if, undefined);
    assert.equal(selector.uses, 'guilhem/jev-ci-selector@v0.1.0');
    assert.equal(selector.with.mode, undefined, 'integrated examples use enforce by default');
    assert.equal(selector.with['api-key'], '${{ secrets.JEV_API_KEY }}');
    assert.equal(selector.with['allow-external-context'], 'true');
    assert.ok(typeof selector.with.tasks === 'string');
    assert.ok(!jobs.plan.steps.some((step: Record<string, unknown>) => step.id === 'full'));
    for (const [output, value] of Object.entries(jobs.plan.outputs)) {
      assert.equal(value, `\${{ steps.select.outputs.${output} }}`);
    }
    assert.deepEqual(Object.keys(workflow.on).sort(), ['merge_group', 'pull_request', 'push', 'schedule']);
    assertReportUpload(workflow, jobs.plan);
    assert.match(readFileSync(resolve(root, 'examples', name, '.github/workflows/ci.yml'), 'utf8'), /tested-sha/);
    assert.match(readFileSync(resolve(root, 'examples', name, '.github/workflows/ci.yml'), 'utf8'), /11bd71901bbe5b1630ceea73d27597364c9af683/);

    if (name === 'static-jobs') {
      assert.deepEqual(Object.keys(jobs).filter((id) => !['plan', 'ci-required'].includes(id)).sort(), tasks);
      assert.deepEqual(finalNeeds, ['build', 'e2e_network', 'e2e_upgrade', 'helm', 'lint', 'plan', 'unit']);
      for (const task of tasks) {
        const needs = Array.isArray(jobs[task].needs) ? jobs[task].needs : [jobs[task].needs];
        assert.ok(needs.includes('plan'), `${task} must depend on plan`);
        assert.equal(jobs.plan.outputs[task], `\${{ steps.select.outputs.${task} }}`);
        assert.match(String(jobs[task].if), new RegExp(`needs\\.plan\\.outputs\\.${task} == ['"]true['"]`));
        assert.doesNotMatch(String(jobs[task].if), /fromJSON\(needs\.plan\.outputs\.run\)/);
      }
      assert.match(jobs['ci-required'].env.NEEDS_JSON, /toJSON\(needs\)/);
      assert.equal(definitions.lint!.always, true);
      assert.equal(definitions.build!.always, true);
      for (const task of ['e2e_network', 'e2e_upgrade']) {
        assert.deepEqual(jobs[task].needs, ['plan', 'build']);
        assert.match(jobs[task].if, /needs.build.result == 'success'/);
      }
    } else {
      assert.deepEqual(Object.keys(jobs).filter((id) => !['plan', 'ci-required'].includes(id)), ['tasks']);
      assert.deepEqual(finalNeeds, ['plan', 'tasks']);
      assert.match(jobs.tasks.if, /has-tasks/);
      assert.match(jobs.tasks.steps[1].run, /unsupported task/);
      const launcher = String(jobs.tasks.steps[1].run);
      for (const task of tasks) assert.match(launcher, new RegExp(`\\b${task}\\)`), `${task} must have a fixed launcher case`);
    }
    assert.deepEqual(jobs['ci-required'].env.EXPECTED_NEEDS.split(',').sort(), finalNeeds);
    for (const definition of Object.values(definitions)) {
      for (const ref of definition.jobs ?? []) {
        assert.equal(ref.workflow, '.github/workflows/ci.yml');
        if (ref.job) assert.ok(jobs[ref.job], 'referenced job must exist');
      }
    }
    for (const task of tasks) assert.match(readFileSync(resolve(root, 'examples', name, '.github/workflows/ci.yml'), 'utf8'), new RegExp(`['"]?${task}['"]?`));
  }
});

test('README targets v0.3.0 while standalone examples retain their release pins', () => {
  const action = parseYaml(readFileSync(resolve(root, 'action.yml'), 'utf8')) as Record<string, any>;
  assert.deepEqual(action.branding, { icon: 'filter', color: 'purple' });
  assert.match(readFileSync(resolve(root, 'README.md'), 'utf8'), /guilhem\/jev-ci-selector@v0\.3\.0/);
  for (const path of [
    'examples/static-jobs/.github/workflows/ci.yml',
    'examples/matrix/.github/workflows/ci.yml',
    'examples/shadow/.github/workflows/observe.yml',
  ]) {
    const source = readFileSync(resolve(root, path), 'utf8');
    assert.match(source, /guilhem\/jev-ci-selector@v0\.1\.0/);
    assert.doesNotMatch(source, /not a claim that the tag has been published/);
  }
});

test('static ci-required rejects planner, plan-shape, selected-job, and dependency failures', () => {
  const workflow = readWorkflow('static-jobs');
  const tasks = taskIds(readTasks('static-jobs'));
  const all = tasks;

  assert.equal(runGate(workflow, planEnv(tasks, all)).status, 0, 'full successful CI must pass');
  assert.equal(runGate(workflow, planEnv(tasks, ['build', 'lint', 'unit'])).status, 0, 'valid selective CI must pass');

  assert.notEqual(runGate(workflow, planEnv(tasks, all, 'failure')).status, 0, 'planner failure must fail the gate');

  const malformed = planEnv(tasks, all);
  malformed.PLAN_RUN = '{';
  assert.notEqual(runGate(workflow, malformed).status, 0, 'malformed plan must fail the gate');

  const selectedSkipped = planEnv(tasks, all);
  const skippedNeeds = JSON.parse(selectedSkipped.NEEDS_JSON);
  skippedNeeds.build.result = 'skipped';
  selectedSkipped.NEEDS_JSON = JSON.stringify(skippedNeeds);
  assert.notEqual(runGate(workflow, selectedSkipped).status, 0, 'a selected skipped job must fail the gate');

  const dependency = planEnv(tasks, ['e2e_network']);
  assert.notEqual(runGate(workflow, dependency).status, 0, 'a selected e2e job without its build must fail the gate');

  assert.notEqual(runGate(workflow, planEnv(tasks, [])).status, 0, 'static mandatory tasks cannot all be skipped');

  const fallbackSelective = planEnv(tasks, ['build', 'lint', 'unit']);
  fallbackSelective.PLAN_STATUS = 'fallback';
  assert.notEqual(runGate(workflow, fallbackSelective).status, 0, 'fallback must select every task');

  const invalidBoolean = planEnv(tasks, ['build', 'lint', 'unit']);
  invalidBoolean.PLAN_RUN = JSON.stringify({ ...JSON.parse(invalidBoolean.PLAN_RUN), helm: 'false' });
  assert.notEqual(runGate(workflow, invalidBoolean).status, 0, 'run values must be booleans');

  const namedMismatch = planEnv(tasks, ['build', 'lint', 'unit']);
  const mismatchedNeeds = JSON.parse(namedMismatch.NEEDS_JSON);
  mismatchedNeeds.plan.outputs.helm = 'true';
  namedMismatch.NEEDS_JSON = JSON.stringify(mismatchedNeeds);
  assert.notEqual(runGate(workflow, namedMismatch).status, 0, 'named task output must agree with aggregate run');

  const namedMalformed = planEnv(tasks, ['build', 'lint', 'unit']);
  const malformedNeeds = JSON.parse(namedMalformed.NEEDS_JSON);
  malformedNeeds.plan.outputs.helm = '1';
  namedMalformed.NEEDS_JSON = JSON.stringify(malformedNeeds);
  assert.notEqual(runGate(workflow, namedMalformed).status, 0, 'named task output must be an exact boolean string');

  const invalidHasTasks = planEnv(tasks, ['build', 'lint', 'unit']);
  invalidHasTasks.PLAN_HAS_TASKS = 'garbage';
  assert.notEqual(runGate(workflow, invalidHasTasks).status, 0, 'has-tasks must be an exact boolean string');
});

test('matrix ci-required accepts an empty matrix and rejects matrix failures and divergence', () => {
  const workflow = readWorkflow('matrix');
  const tasks = taskIds(readTasks('matrix'));
  const empty = runGate(workflow, matrixEnv(tasks, [], 'skipped'));
  assert.equal(empty.status, 0, `empty matrix is a valid no-task plan: ${empty.output}`);
  for (const invalidSelected of [null, {}, false, 'invalid']) {
    const invalid = matrixEnv(tasks, [], 'skipped');
    invalid.PLAN_SELECTED = JSON.stringify(invalidSelected);
    assert.notEqual(runGate(workflow, invalid).status, 0, 'a malformed selected value must not become an empty successful plan');
  }
  assert.equal(runGate(workflow, matrixEnv(tasks, ['build', 'lint'])).status, 0);
  assert.notEqual(runGate(workflow, matrixEnv(tasks, ['build'], 'failure')).status, 0, 'matrix failure must fail the gate');
  for (const result of ['failure', 'skipped', 'cancelled']) {
    const invalid = matrixEnv(tasks, [], 'skipped');
    invalid.PLAN_RESULT = result;
    assert.notEqual(runGate(workflow, invalid).status, 0, 'empty matrices still require successful planning');
  }

  const extraMatrixItem = matrixEnv(tasks, ['build']);
  extraMatrixItem.PLAN_MATRIX = JSON.stringify({ include: [{ task: 'build', extra: true }] });
  assert.notEqual(runGate(workflow, extraMatrixItem).status, 0, 'matrix entries must have only task');

  const bypassedSelective = matrixEnv(tasks, ['build']);
  bypassedSelective.PLAN_STATUS = 'bypassed';
  assert.notEqual(runGate(workflow, bypassedSelective).status, 0, 'bypassed must select every task');

  const divergence = matrixEnv(tasks, ['build']);
  divergence.PLAN_RUN = JSON.stringify({ build: true, lint: false, unit: false, unexpected: false });
  assert.notEqual(runGate(workflow, divergence).status, 0, 'task/output divergence must fail the gate');
});

test('shadow observer is isolated from consumer CI jobs', () => {
  const workflow = parseYaml(readFileSync(resolve(root, 'examples/shadow/.github/workflows/observe.yml'), 'utf8'));
  assert.deepEqual(workflow.on, { pull_request: null });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['observe']);
  const job = workflow.jobs.observe;
  assert.equal(job.needs, undefined);
  assert.equal(job.outputs, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job.steps.length, 2);
  const selector = job.steps[0];
  assert.equal(selector.id, 'select');
  assert.equal(selector.uses, 'guilhem/jev-ci-selector@v0.1.0');
  assert.equal(selector.if, undefined);
  assert.equal(selector.with.mode, 'shadow');
  assert.equal(selector.with['allow-external-context'], 'true');
  assertReportUpload(workflow, job);
  assert.ok(job.steps.every((step: Record<string, any>) => !step.run && !String(step.uses).startsWith('actions/checkout@')));
  const definitions = readTasks('shadow');
  assert.deepEqual(taskIds(definitions), ['build', 'unit']);
  for (const task of taskIds(definitions)) {
    assert.deepEqual(definitions[task]!.jobs, [{ workflow: '.github/workflows/ci.yml', job: task }]);
  }
});

test('both gates preserve the event SHA contract and full bypass plans', () => {
  for (const name of examples) {
    const workflow = readWorkflow(name);
    const tasks = taskIds(readTasks(name));
    const env = name === 'static-jobs' ? planEnv(tasks, tasks) : matrixEnv(tasks, tasks);
    env.PLAN_STATUS = 'bypassed';
    assert.equal(runGate(workflow, env).status, 0);
    for (const sha of ['', 'b'.repeat(40)]) {
      assert.notEqual(runGate(workflow, { ...env, PLAN_TESTED_SHA: sha }).status, 0);
    }
    assert.equal(workflow.jobs['ci-required'].env.EXPECTED_TESTED_SHA, '${{ github.sha }}');
    for (const job of Object.values(workflow.jobs) as Array<Record<string, any>>) {
      for (const step of job.steps) {
        if (String(step.uses).startsWith('actions/checkout@')) {
          assert.equal(step.with.ref, '${{ needs.plan.outputs.tested-sha }}');
        }
      }
    }
  }
});

test('README quickstart has two jobs and valid inline tasks', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const block = readme.match(/```yaml\n([\s\S]*?)\n```/);
  assert.ok(block);
  const workflow = parseYaml(block[1]!);
  assert.deepEqual(Object.keys(workflow.jobs), ['selection', 'unit']);
  const selection = workflow.jobs.selection;
  assert.equal(selection.steps.length, 1);
  assert.deepEqual(taskIds(parseTasks(selection.steps[0].with.tasks)), ['unit']);
  assert.equal(selection.steps[0].with.mode, 'shadow');
  assert.equal(selection.outputs.unit, '${{ steps.select.outputs.unit }}');
  assert.equal(selection.outputs['tested-sha'], '${{ steps.select.outputs.tested-sha }}');
  assert.equal(workflow.jobs.unit.needs, 'selection');
  assert.equal(workflow.jobs.unit.if, "${{ needs.selection.outputs.unit == 'true' }}");
  assert.equal(workflow.jobs.unit.steps[0].with.ref, '${{ needs.selection.outputs.tested-sha }}');
});
