import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalActionResolver } from '../../src/external.js';

const request = { repository: 'owner/action', commit: 'a'.repeat(40), uses: 'owner/action/sub@v1', path: 'sub', ref: 'v1' };
test('external action reads its declared ref once and pins all metadata reads to the resolved SHA', async () => {
  const urls: string[] = [];
  const sha = 'b'.repeat(40);
  const resolver = externalActionResolver('https://github.com', 'private', async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer private');
    if (String(url).endsWith('/commits/v1')) return Response.json({ sha });
    assert.match(String(url), new RegExp(`ref=${sha}$`));
    if (String(url).includes('action.yml?')) return new Response('', { status: 404 });
    return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from('description: Actual description').toString('base64') });
  });
  const results = await Promise.all([resolver(request), resolver(request)]);
  assert.equal(urls.length, 3);
  assert.equal(results[0]?.commit, sha);
  assert.equal(results[0]?.file, 'sub/action.yaml');
  assert.equal(results[0], results[1]);
});

test('unavailable action metadata is explicit and provider body never escapes', async () => {
  const resolver = externalActionResolver('https://github.com', '', async () => { throw new Error('private body'); });
  assert.equal(await resolver(request), null);
});
