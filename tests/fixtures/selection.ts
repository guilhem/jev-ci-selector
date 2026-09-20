import type { ResolvedSelection } from '../../src/tasks.js';
export function selection(): ResolvedSelection {
  return { model: 'jev-1.13.0', skip_below: 0.05, tasks: {
    unit: { always: true, evidence: { description: 'Checks unit behavior.' } },
    helm: { evidence: { description: 'Does this change affect chart rendering?' }, force_paths: ['charts/**'] },
    e2e: { evidence: { description: 'Does this change affect network routing?' } },
    build: { evidence: { description: 'Does this change affect compilation?' } },
    prepare: { evidence: { description: 'Does this change affect generated files?' } },
  } };
}
