// Test-only transport interception; Git remotes and HTTP responses stay local.
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === 'git') args = args.map(arg => arg === 'https://github.com/acme/example.git' ? process.env.FIXTURE_REMOTE : arg);
  return originalSpawn.call(this, command, args, options);
};
globalThis.fetch = async (url, init) => {
  if (url !== (process.env.FIXTURE_API_URL || 'https://api.typesafe.ai/v1/systemone')) throw new Error('Unexpected network request in test');
  if (!process.env.FIXTURE_RESPONSE) throw new Error('Unexpected semantic request in test');
  if (JSON.parse(init.body).model !== (process.env.FIXTURE_API_MODEL || 'jev-1.13.0')) throw new Error('Unexpected API model in test');
  if (new Headers(init.headers).get('Authorization') !== 'Bearer SECRET-SENTINEL') throw new Error('Unexpected API key in test');
  if (init.redirect !== 'error') throw new Error('Redirects must be disabled');
  return new Response(process.env.FIXTURE_RESPONSE, { status: 200 });
};
