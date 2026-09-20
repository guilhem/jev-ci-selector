import * as core from '@actions/core';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './config.js';
import { eventContext, planChange, type Inputs } from './planner.js';
import { actionOutputs, summary } from './report.js';
import { manualContext } from './manual.js';

function booleanInput(name: string): boolean {
  const value = core.getInput(name) || 'false';
  if (value !== 'true' && value !== 'false') throw new Error('invalid-input');
  return value === 'true';
}
function integerInput(name: string, defaultValue: number): number {
  const value = core.getInput(name) || String(defaultValue);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalid-input');
  return Number(value);
}
async function main(): Promise<void> {
  const mode = core.getInput('mode') || 'shadow';
  if (mode !== 'shadow' && mode !== 'enforce') throw new Error('invalid-input');
  const inputs: Inputs = {
    config: core.getInput('config') || '.github/ci-selector.yml', mode,
    githubToken: core.getInput('github-token'), apiKey: core.getInput('api-key'),
    apiBaseUrl: core.getInput('api-base-url'), apiModel: core.getInput('api-model'),
    allowExternalContext: booleanInput('allow-external-context'), forceAll: booleanInput('force-all'),
    timeoutMs: integerInput('timeout-ms', 10000), maxDiffBytes: integerInput('max-diff-bytes', 65536),
  };
  const event: unknown = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const pullRequest = core.getInput('pull-request');
  const context = pullRequest
    ? await manualContext(process.env, pullRequest, mode, inputs.githubToken)
    : eventContext(process.env, event);
  const { plan, report } = await planChange(inputs, context);
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'jev-ci-selector-report-'));
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  // Publish only after the complete, validated report has been persisted.
  for (const [name, value] of Object.entries(actionOutputs(plan, context.testedSha, reportPath))) core.setOutput(name, value);
  await core.summary.addRaw(summary(report)).write();
  core.info(`jev-ci-selector: ${plan.status}, ${plan.selected.length}/${Object.keys(plan.tasks).length} tasks (${plan.mode})`);
}
void main().catch(error => {
  // Error objects can carry HTTP bodies, source code, paths and credentials. Never log them.
  core.setFailed(error instanceof ConfigError ? 'jev-ci-selector: catalog unavailable or invalid; no plan published.' :
    'jev-ci-selector: planner failed; CI must reject this run.');
});
