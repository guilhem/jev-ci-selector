import * as core from '@actions/core';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError, actionFailureMessage } from './input-error.js';
import { eventContext, planChange, validateInputs, type Inputs } from './planner.js';
import { parseSelectionInputs } from './tasks.js';
import { actionOutputs, summary } from './report.js';
import { manualContext } from './manual.js';
import { ANALYSIS_BYTES, COLLECTED_PATCH_BYTES, JEV_CALLS } from './budget.js';

function booleanInput(name: 'allow-external-context' | 'force-all'): boolean {
  const value = core.getInput(name) || 'false';
  if (value !== 'true' && value !== 'false') throw new InputError(name);
  return value === 'true';
}
type IntegerInput = 'timeout-ms' | 'max-collected-patch-bytes' | 'max-analysis-bytes' | 'max-jev-calls';
function integerInput(name: IntegerInput, defaultValue: number): number {
  const value = core.getInput(name) || String(defaultValue);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError(name);
  return Number(value);
}
async function main(): Promise<void> {
  // `max-diff-bytes` no longer has a meaning: the action never builds a complete
  // diff. Rather than silently reinterpreting it, say so and fail.
  if (core.getInput('max-diff-bytes')) throw new InputError('max-diff-bytes');
  const mode = core.getInput('mode') || 'enforce';
  if (mode !== 'shadow' && mode !== 'enforce') throw new InputError('mode');
  const testedRef = core.getInput('tested-ref') || 'merge';
  if (testedRef !== 'head' && testedRef !== 'merge') throw new InputError('tested-ref');
  const inputs: Inputs = {
    ...parseSelectionInputs(core.getInput), mode, testedRef,
    githubToken: core.getInput('github-token'), apiKey: core.getInput('api-key'),
    apiBaseUrl: core.getInput('api-base-url'), apiModel: core.getInput('api-model'),
    allowExternalContext: booleanInput('allow-external-context'), forceAll: booleanInput('force-all'),
    timeoutMs: integerInput('timeout-ms', 10000),
    maxCollectedPatchBytes: integerInput('max-collected-patch-bytes', COLLECTED_PATCH_BYTES),
    maxAnalysisBytes: integerInput('max-analysis-bytes', ANALYSIS_BYTES),
    maxJevCalls: integerInput('max-jev-calls', JEV_CALLS),
  };
  validateInputs(inputs);
  const event: unknown = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const pullRequest = core.getInput('pull-request');
  const context = pullRequest
    ? await manualContext(process.env, pullRequest, mode, inputs.githubToken, globalThis.fetch, testedRef)
    : eventContext(process.env, event, testedRef);
  if (pullRequest && testedRef === 'head') context.testedSha = context.headSha;
  const { plan, report } = await planChange(inputs, context);
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'jev-ci-selector-report-'));
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  // Publish only after the complete, validated report has been persisted.
  for (const [name, value] of Object.entries(actionOutputs(plan, context.testedSha, reportPath))) core.setOutput(name, value);
  try {
    await core.summary.addRaw(summary(report)).write();
  } catch {
    core.warning('summary-unavailable');
  }
  core.info(`jev-ci-selector: ${plan.status}, ${plan.selected.length}/${Object.keys(plan.tasks).length} tasks (${plan.mode})`);
  const { analysis } = report;
  core.info(`analysis: ${analysis.required_without_analysis.length} forced, ${analysis.analysed_tasks.length} analysed;`
    + ` ${analysis.collected_patch_bytes} patch bytes; ${analysis.jev_calls} Jev calls`);
  if (analysis.fallback_scope !== 'none') {
    // Reasons and task IDs come from fixed allowlists, never from error text.
    core.info(`reason=${analysis.limits_reached.join(',') || plan.status} scope=${analysis.fallback_scope}`
      + ` affected_tasks=${analysis.fallback_tasks.join(',')}`);
  }
}
void main().catch(error => {
  // Error objects can carry HTTP bodies, source code, paths and credentials. Never log them.
  core.setFailed(actionFailureMessage(error));
});
