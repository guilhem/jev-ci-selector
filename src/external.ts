import type { ExternalResolution, ExternalResolutionRequest } from './metadata.js';

/** Read action metadata at its declared ref, without running action code. */
export function externalActionResolver(serverUrl: string, token: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const api = serverUrl === 'https://github.com' ? 'https://api.github.com' : `${serverUrl}/api/v3`;
  const cache = new Map<string, Promise<ExternalResolution | null>>();
  const revisions = new Map<string, Promise<string | null>>();
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  async function get(path: string): Promise<unknown> {
    const response = await fetchImpl(`${api}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    // GitHub Contents has its own limit; cap the received metadata too.
    const body = await response.text();
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) return null;
    try { return JSON.parse(body); } catch { return null; }
  }
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  async function resolve(request: ExternalResolutionRequest): Promise<ExternalResolution | null> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) || !request.ref ||
      (request.path !== '.' && request.path.split('/').some(part => !part || part === '.' || part === '..')) || request.path.includes('\\')) return null;
    const revisionKey = `${request.repository}@${request.ref}`;
    if (!revisions.has(revisionKey)) revisions.set(revisionKey, (async () => {
      const value = await get(`/repos/${request.repository}/commits/${encodeURIComponent(request.ref)}`);
      return object(value) && typeof value.sha === 'string' && /^[a-f0-9]{40}$/.test(value.sha) ? value.sha : null;
    })());
    const commit = await revisions.get(revisionKey)!;
    if (!commit) return null;
    for (const name of ['action.yml', 'action.yaml']) {
      const file = request.path === '.' ? name : `${request.path}/${name}`;
      const value = await get(`/repos/${request.repository}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`);
      if (!object(value) || value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') continue;
      const content = Buffer.from(value.content, 'base64');
      if (content.length > 1024 * 1024) return null;
      return { repository: request.repository, commit, sha: commit, file, content };
    }
    return null;
  }
  return (request: ExternalResolutionRequest): Promise<ExternalResolution | null> => {
    const key = `${request.repository}@${request.ref}/${request.path}`;
    if (!cache.has(key)) cache.set(key, resolve(request).catch(() => null));
    return cache.get(key)!;
  };
}
