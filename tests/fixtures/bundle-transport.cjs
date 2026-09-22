// Test-only transport interception; Git remotes and HTTP responses stay local.
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === 'git') args = args.map(arg => arg === 'https://github.com/acme/example.git' ? process.env.FIXTURE_REMOTE : arg);
  return originalSpawn.call(this, command, args, options);
};
globalThis.fetch = async (url, init) => {
  if (url === 'https://api.github.com/repos/acme/example/pulls/42' && process.env.FIXTURE_PULL_REQUEST) {
    if (new Headers(init.headers).get('Authorization') !== 'Bearer TOKEN-SENTINEL') throw new Error('Unexpected GitHub token in test');
    if (init.redirect !== 'error') throw new Error('Redirects must be disabled');
    return Response.json(JSON.parse(process.env.FIXTURE_PULL_REQUEST));
  }
  if (url !== (process.env.FIXTURE_API_URL || 'https://api.typesafe.ai/v1/systemone')) throw new Error('Unexpected network request in test');
  if (!process.env.FIXTURE_RESPONSE) throw new Error('Unexpected semantic request in test');
  if (JSON.parse(init.body).model !== (process.env.FIXTURE_API_MODEL || 'jev-1.13.0')) throw new Error('Unexpected API model in test');
  if (new Headers(init.headers).get('Authorization') !== 'Bearer SECRET-SENTINEL') throw new Error('Unexpected API key in test');
  if (init.redirect !== 'error') throw new Error('Redirects must be disabled');
  if (process.env.FIXTURE_REQUESTS) require('node:fs').appendFileSync(process.env.FIXTURE_REQUESTS, init.body + '\n');
  const request = JSON.parse(init.body);
  const fixture = JSON.parse(process.env.FIXTURE_RESPONSE);
  if (fixture.model && fixture.answers && Object.values(request.questions).every(question => question.type === 'choice' && Object.hasOwn(question.criteria, 'uncertain'))) {
    return Response.json({ model: fixture.model, usage: { input_tokens: 10, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const path = question.instructions.path;
        const read = request.state.sources.some(source => source.path === path);
        const relevant = request.state.job?.id === 'unit' && (path === 'check.sh' || path === 'checks.ini' && request.state.sources.some(source => source.content.includes('checks.ini')));
        const selected = read ? 'keep' : relevant ? 'inspect' : 'ignore';
        return [id, { type: 'choice', choice: selected, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === selected ? 1 : 0])) }];
      })) });
  }
  // Answer exactly the questions this request carries. The action now asks only
  // about tasks that are still open, so a fixed answer set would otherwise look
  // like an invalid response as soon as a task is settled deterministically.
  if (fixture.answers && typeof fixture.answers === 'object') {
    const answers = Object.fromEntries(Object.keys(request.questions)
      .filter(id => Object.hasOwn(fixture.answers, id))
      .map(id => [id, fixture.answers[id]]));
    return Response.json({ ...fixture, answers });
  }
  return new Response(process.env.FIXTURE_RESPONSE, { status: 200 });
};
