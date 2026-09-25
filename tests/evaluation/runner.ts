import { resolve } from 'node:path';
import { inspectCorpus, replayMockChoices } from './evaluation.js';

async function main(): Promise<void> {
  if (process.argv[2] !== 'replay' || process.argv.length !== 3) throw new Error('usage: runner.ts replay');
  const root = resolve('tests/evaluation');
  const corpus = await inspectCorpus(root);
  const replay = await replayMockChoices(root);
  process.stdout.write(`${JSON.stringify({ mode: 'replay', corpus, ...replay })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'evaluation-error'}\n`);
  process.exitCode = 1;
});
