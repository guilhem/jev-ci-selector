import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSelection, corpusFingerprint, loadCases, readCorpus, replayCampaign, replayChoiceRegressions, runLiveCampaign, writeJson, type Selection } from './evaluation.js';
import { compareCampaigns, resolveBaselineCampaign } from './comparison.js';
import { summarizeCampaign } from './summary.js';

function argumentMap(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new Error(`unknown-argument:${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing-argument:${arg}`);
    values.set(arg.slice(2), value); index += 1;
  }
  return values;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = argumentMap(rest);
  const root = resolve(args.get('corpus-root') ?? 'tests/evaluation');
  if (command === 'replay') {
    const campaign = args.get('campaign');
    const result = campaign
      ? await replayCampaign(root, resolve(campaign), args.get('case')?.split(',').filter(Boolean))
      : await replayChoiceRegressions(join(root, 'recordings', 'choice-regressions.json'));
    process.stdout.write(`${JSON.stringify({ mode: 'replay', ...result })}\n`);
    return;
  }
  if (command !== 'live') throw new Error('usage: runner.ts replay|live');
  const split = args.get('split');
  if (split !== 'calibration' && split !== 'validation') throw new Error('live-requires-split');
  const baseline = await resolveBaselineCampaign(args.get('baseline'));
  const key = process.env.JEV_API_KEY || process.env.JEV_KEY_API || process.env.TYPESAFE_API_KEY || '';
  if (!key.trim()) throw new Error('live-requires-api-key');
  let selection: Selection | undefined;
  if (split === 'validation') {
    const selectionPath = args.get('selection');
    if (!selectionPath) throw new Error('validation-requires-selection');
    selection = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(selectionPath), 'utf8')) as Selection;
    const corpus = await readCorpus(root);
    const loaded = await loadCases(root, corpus, 'calibration', selection?.caseIds);
    assertSelection(selection, await corpusFingerprint(corpus, loaded));
  }
  const temporaryRoot = args.get('output') ? null : await mkdtemp(join(tmpdir(), 'jev-evaluation-report-'));
  const output = args.get('output') ?? join(temporaryRoot!, 'campaign');
  const apiBaseUrl = args.get('api-base-url');
  const apiModel = args.get('api-model');
  const result = await runLiveCampaign({ root, split, apiKey: key, output,
    ...(args.get('case') ? { caseIds: args.get('case')!.split(',').filter(Boolean) } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}), ...(apiModel ? { apiModel } : {}), ...(selection ? { selection } : {}),
    progress: message => process.stderr.write(`${message}\n`) });
  await writeJson(join(result.output, 'summary.json'), await summarizeCampaign(result.output));
  const comparison = await compareCampaigns(baseline, result.output);
  await writeJson(join(result.output, 'comparison.json'), comparison);
  process.stdout.write(`${JSON.stringify({ mode: 'live', split, output: result.output, baseline, runs: result.records.length, qualified: result.manifest.selection?.qualified ?? null, comparable: comparison.comparable })}\n`);
}

const isMain = typeof __filename === 'string' && process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(__filename);
if (isMain) main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'evaluation-error'}\n`);
  process.exitCode = 1;
});

export * from './evaluation.js';
