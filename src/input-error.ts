const constraints = {
  tasks: 'a YAML mapping of task objects containing only description (nonempty string); move always and force_paths rules into the caller workflow; jobs, context_files and resolve_context_files are no longer supported',
  model: 'a canonical Jev version in the form jev-X.Y.Z',
  mode: 'no value; mode was removed, so observe selection by running caller jobs independently of the action outputs',
  'tested-ref': 'one of "head" or "merge"',
  'allow-external-context': '"true" or "false"',
  'force-all': 'no value; force-all was removed, so bypass the action and run jobs in the caller workflow',
  'timeout-ms': 'an integer from 1 to 2147483647',
  'max-diff-bytes': 'no value; it was replaced by "max-collected-patch-bytes", which bounds the patch text actually collected rather than the size of a complete diff',
  'max-collected-patch-bytes': 'a positive safe integer',
  'max-analysis-bytes': 'a positive safe integer',
  'max-jev-calls': 'a positive safe integer',
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
  return 'jev-ci-selector: planner failed; CI must reject this run.';
}
