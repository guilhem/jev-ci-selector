import { ConfigError } from './config.js';

const constraints = {
  mode: 'one of "shadow" or "enforce"',
  'tested-ref': 'one of "head" or "merge"',
  'allow-external-context': '"true" or "false"',
  'force-all': '"true" or "false"',
  'timeout-ms': 'an integer from 1 to 2147483647',
  'max-diff-bytes': 'a positive safe integer',
  'api-base-url': 'an absolute HTTPS URL without credentials, query, fragment, whitespace, control characters or backslashes',
  'api-model': '1–128 characters, starting with an ASCII letter or digit and containing only ASCII letters, digits, ".", "_", ":", "/" or "-"',
} as const;

export type InputField = keyof typeof constraints;

export class InputError extends Error {
  constructor(public readonly field: InputField) { super('invalid-input'); }
}

export function actionFailureMessage(error: unknown): string {
  if (error instanceof InputError && Object.hasOwn(constraints, error.field)) {
    // Both the field and constraint come from a fixed allowlist, never error.message.
    const field = error.field;
    return `jev-ci-selector: invalid input "${field}"; expected ${constraints[field]}; no plan published.`;
  }
  return error instanceof ConfigError
    ? 'jev-ci-selector: catalog unavailable or invalid; no plan published.'
    : 'jev-ci-selector: planner failed; CI must reject this run.';
}
