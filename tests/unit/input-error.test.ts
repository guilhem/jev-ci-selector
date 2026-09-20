import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { InputError, actionFailureMessage } from '../../src/input-error.js';
import { ConfigError } from '../../src/config.js';
import { resolveJevApi } from '../../src/jev.js';
import { planChange, type Inputs, type Context } from '../../src/planner.js';

test('public diagnostics use fixed fields and constraints, never raw errors', () => {
  const error = new InputError('api-model');
  error.message = 'SECRET-SENTINEL';
  const message = actionFailureMessage(error);
  assert.match(message, /invalid input "api-model"; expected 1–128 characters/);
  assert.ok(!message.includes('SECRET-SENTINEL'));
  for (const error of [new Error('SECRET-SENTINEL'), { field: 'api-model', message: 'SECRET-SENTINEL' },
    new InputError('SECRET-SENTINEL' as never)]) {
    assert.equal(actionFailureMessage(error), 'jev-ci-selector: planner failed; CI must reject this run.');
  }
  const config = new ConfigError();
  config.message = 'SECRET-SENTINEL';
  assert.equal(actionFailureMessage(config), 'jev-ci-selector: catalog unavailable or invalid; no plan published.');
});

test('API input errors preserve the legacy message and distinguish URL and model', () => {
  for (const [options, field] of [
    [{ apiBaseUrl: 'https://user:SECRET-SENTINEL@api.test' }, 'api-base-url'],
    [{ apiBaseUrl: 'SECRET-SENTINEL' }, 'api-base-url'],
    [{ apiModel: 'SECRET-SENTINEL invalid' }, 'api-model'],
  ] as const) {
    assert.throws(() => resolveJevApi(options), (error: unknown) => {
      assert.ok(error instanceof InputError);
      assert.equal(error.message, 'invalid-input');
      assert.equal(error.field, field);
      assert.ok(!actionFailureMessage(error).includes('SECRET-SENTINEL'));
      return true;
    });
  }
});

test('planner identifies invalid inputs before repository access', async () => {
  const inputs: Inputs = { config: '.github/task-routing.yaml', mode: 'shadow', githubToken: '', apiKey: '',
    allowExternalContext: false, forceAll: false, timeoutMs: 1000, maxDiffBytes: 65536 };
  for (const [override, field] of [
    [{ mode: 'SECRET-SENTINEL' }, 'mode'], [{ testedRef: 'SECRET-SENTINEL' }, 'tested-ref'],
    [{ timeoutMs: 2147483648 }, 'timeout-ms'], [{ timeoutMs: 0 }, 'timeout-ms'],
    [{ maxDiffBytes: Number.MAX_SAFE_INTEGER + 1 }, 'max-diff-bytes'],
    [{ maxDiffBytes: 1.5 }, 'max-diff-bytes'],
    [{ apiBaseUrl: 'SECRET-SENTINEL' }, 'api-base-url'],
    [{ apiModel: 'SECRET-SENTINEL invalid' }, 'api-model'],
  ] as const) {
    let accessed = false;
    await assert.rejects(planChange({ ...inputs, ...override } as Inputs, {} as Context, {
      createRepository: async () => { accessed = true; throw new Error('unexpected access'); },
    }), (error: unknown) => {
      assert.ok(error instanceof InputError);
      assert.equal(error.message, 'invalid-input');
      assert.equal(error.field, field);
      return true;
    });
    assert.equal(accessed, false);
  }
});

test('action prints safe diagnostics for malformed enum, boolean and integer inputs', () => {
  for (const field of ['mode', 'tested-ref', 'allow-external-context', 'force-all', 'timeout-ms', 'max-diff-bytes']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_')));
    env['INPUT_' + field.toUpperCase()] = 'SECRET-SENTINEL';
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/action.ts'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp('invalid input "' + field + '"; expected '));
    assert.ok(!(result.stdout + result.stderr).includes('SECRET-SENTINEL'));
    assert.ok(!result.stdout.includes('::set-output'));
  }
});
