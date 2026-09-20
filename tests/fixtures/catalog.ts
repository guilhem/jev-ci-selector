import type { CatalogV1 } from '../../src/config.js';
export function catalog(): CatalogV1 {
  return {
    version: 1, model: 'jev-1.13.0', skip_below: 0.05,
    tasks: {
      unit: { always: true },
      helm: { question: 'Does this change affect chart rendering?', force_paths: ['charts/**'] },
      e2e: { question: 'Does this change affect network routing?', requires: ['build'] },
      build: { question: 'Does this change affect compilation?', requires: ['prepare'] },
      prepare: { question: 'Does this change affect generated files?' },
    },
  };
}
