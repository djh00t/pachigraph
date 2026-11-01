import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

import { loadArchive } from '../app/archive.ts';
import { migrate } from '../db/migrate.ts';
import { createKeys } from '../server/api-keys.ts';
import {
  sessionPrincipal,
  type Principal,
  type VerifiedUser,
} from '../server/auth.ts';
import { dispatchAPI, dispatchMCP } from '../server/dispatch.ts';
import { createHistory } from '../server/history.ts';
import { handleMCP } from '../server/mcp.ts';
import { WhoamiResponse, handleAPI, safeResponse } from '../server/http.ts';
import { clearStorage, seedTenant, testPool } from './storage-support.ts';

const pool = testPool();
const TENANT_A = 't-aaaaaaaaaaaaaaaa';
const TENANT_B = 't-bbbbbbbbbbbbbbbb';
const THREAD = '018f47a8-4af3-7b83-bf0e-6f2b4e955c12';
const SOURCE = 'a'.repeat(64);

class MemoryObjects {
  readonly objects = new Map<string, string>();
  async putImmutable(key: string, value: string) {
    if (!this.objects.has(key)) this.objects.set(key, value);
  }
  async getText(key: string) {
    return this.objects.get(key) ?? null;
  }
  async deletePrefix(prefix: string) {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

function request(path: string, method = 'GET', token?: string, body?: unknown) {
  return new Request('https://site.test' + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function profile(
  subject: string,
  expiresAt = new Date('2026-04-01T00:00:00.000Z'),
): VerifiedUser {
  return {
    userId: subject,
    displayName: subject,
    email: '',
    fullName: null,
    expiresAt,
  };
}

before(async () => migrate(pool));
beforeEach(async () => {
  await clearStorage(pool);
  await seedTenant(pool, TENANT_A, 'subject-a');
  await seedTenant(pool, TENANT_B, 'subject-b');
});
after(async () => pool.end());

async function principals() {
  const sessionA = await sessionPrincipal(pool, profile('subject-a'));
  const sessionB = await sessionPrincipal(pool, profile('subject-b'));
  return { sessionA, sessionB };
}

test('whoami returns the caller tenant, scope and expiry and is not cached', async () => {
  const { sessionA } = await principals();
  const history = createHistory(pool, new MemoryObjects());
  for (const scope of ['read', 'ingest', 'session'] as const) {
    const principal: Principal =
      scope === 'session' ? sessionA : { ...sessionA, scope };
    const response = await handleAPI(
      request('/api/whoami'),
      principal,
      history,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = WhoamiResponse.parse(await response.json());
    assert.equal(body.tenant, TENANT_A);
    assert.equal(body.scope, scope);
    assert.equal(body.expires_at, principal.expiresAt.toISOString());
  }
});

test('a session cannot ingest and a cross-origin delete stays origin rejected', async () => {
  const { sessionA } = await principals();
  const history = createHistory(pool, new MemoryObjects());
  const ingest = await handleAPI(
    request('/api/ingest', 'POST', undefined, {
      thread_id: THREAD,
      records: [],
    }),
    sessionA,
    history,
  );
  assert.equal(ingest.status, 403);
  assert.equal((await ingest.json()).error, 'Scope not allowed');
  const deleted = await handleAPI(
    request('/api/thread?id=' + THREAD, 'DELETE', undefined, undefined),
    sessionA,
    history,
  );
  assert.equal(deleted.status, 200);
  const foreign = await handleAPI(
    new Request('https://site.test/api/thread?id=' + THREAD, {
      method: 'DELETE',
      headers: { origin: 'https://evil.test' },
    }),
    sessionA,
    history,
  );
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'Origin rejected');
});

test('read and ingest keys follow the scope matrix, including the reason', async () => {
  const keys = createKeys(pool);
  const { sessionA } = await principals();
  const read = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'read', days: 2 }),
      sessionA,
    )
  ).json()) as { key: string };
  const ingest = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'ingest', days: 2 }),
      sessionA,
    )
  ).json()) as { key: string };
  const denied = keys.resolve(request('/api/ingest', 'POST', read.key));
  await assert.rejects(denied, { status: 403, message: 'Scope not allowed' });
  assert.equal(
    (await keys.resolve(request('/api/whoami', 'GET', ingest.key)))?.scope,
    'ingest',
  );
  assert.equal(
    (await keys.resolve(request('/api/search', 'GET', read.key)))?.tenant,
    TENANT_A,
  );
});

test('another tenant looks missing through HTTP, dispatch and the page loader', async () => {
  const objects = new MemoryObjects();
  const history = createHistory(pool, objects);
  const { sessionA, sessionB } = await principals();
  await history.ingest(sessionB.tenant, {
    thread_id: THREAD,
    records: [
      {
        id: SOURCE,
        timestamp: '2026-09-05T01:02:03.000Z',
        text: 'beta only token xylophone',
        record: { side: 'beta' },
      },
    ],
  });
  const hidden = (await history.search(sessionB.tenant, 'xylophone'))
    .results[0];
  const missing = await handleAPI(
    request('/api/fetch?id=' + 'f'.repeat(64)),
    sessionA,
    history,
  );
  const foreign = await handleAPI(
    request('/api/fetch?id=' + hidden.id + '&tenant=' + TENANT_B),
    sessionA,
    history,
  );
  assert.equal(foreign.status, 404);
  assert.equal(await foreign.text(), await missing.text());
  const search = await handleAPI(
    request('/api/search?q=xylophone&tenant=' + TENANT_B),
    sessionA,
    history,
  );
  assert.deepEqual(await search.json(), { results: [] });
  const status = await handleAPI(request('/api/status'), sessionA, history);
  assert.equal((await status.json()).records, 0);

  const keys = createKeys(pool);
  const read = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'read', days: 2 }),
      sessionA,
    )
  ).json()) as { key: string };
  const dispatched = await safeResponse(() =>
    dispatchAPI(
      request('/api/search?q=xylophone&tenant=' + TENANT_B, 'GET', read.key),
      null,
      keys,
      history,
      pool,
    ),
  );
  const dispatchedBody = await dispatched.json();
  assert.equal(dispatched.status, 200);
  assert.deepEqual(dispatchedBody, { results: [] });
  const resolved = await keys.resolve(request('/api/search', 'GET', read.key));
  const direct = await handleAPI(
    request('/api/search?q=xylophone'),
    resolved,
    history,
  );
  assert.deepEqual(await direct.json(), dispatchedBody);

  const page = await loadArchive(sessionA.tenant, history, {
    q: 'xylophone',
    id: hidden.id,
  });
  assert.equal(page.results.length, 0);
  assert.equal(page.selected, null);
  assert.equal(page.fetchError, true);
  const route = await readFile(
    new URL('../app/api/[action]/route.ts', import.meta.url),
    'utf8',
  );
  const view = await readFile(
    new URL('../app/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(route, /dispatchAPI\(/);
  assert.equal(route.includes('userId'), false);
  assert.match(view, /loadArchive\(\s*principal\.tenant/);
  assert.equal(view.includes('user.userId'), false);
});

test('a session ingest through dispatch is rejected and a key ingest is not', async () => {
  const { sessionA } = await principals();
  const history = createHistory(pool, new MemoryObjects());
  const keys = createKeys(pool);
  const denied = await safeResponse(() =>
    dispatchAPI(
      request('/api/ingest', 'POST', undefined, {
        thread_id: THREAD,
        records: [],
      }),
      profile('subject-a'),
      keys,
      history,
      pool,
    ),
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'Scope not allowed');
  const ingest = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'ingest', days: 1 }),
      sessionA,
    )
  ).json()) as { key: string };
  const allowed = await safeResponse(() =>
    dispatchAPI(
      request('/api/whoami', 'GET', ingest.key),
      null,
      keys,
      history,
      pool,
    ),
  );
  const body = WhoamiResponse.parse(await allowed.json());
  assert.equal(body.scope, 'ingest');
  assert.equal(body.tenant, TENANT_A);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
});

function rpc(method: string, params: unknown = {}) {
  return new Request('https://site.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

test('MCP search fetch and status stay inside the caller tenant', async () => {
  const objects = new MemoryObjects();
  const history = createHistory(pool, objects);
  const { sessionA, sessionB } = await principals();
  await history.ingest(sessionB.tenant, {
    thread_id: THREAD,
    records: [
      {
        id: SOURCE,
        timestamp: '2026-09-05T01:02:03.000Z',
        text: 'beta only token xylophone',
        record: { side: 'beta' },
      },
    ],
  });
  const hidden = (await history.search(sessionB.tenant, 'xylophone'))
    .results[0];
  const keys = createKeys(pool);
  const read = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'read', days: 2 }),
      sessionA,
    )
  ).json()) as { key: string };
  const listed = await handleMCP(rpc('tools/list'), sessionA, history);
  assert.equal(listed.status, 200);
  const searchBody = JSON.stringify(
    await (
      await handleMCP(
        rpc('tools/call', {
          name: 'search',
          arguments: { query: 'xylophone' },
        }),
        sessionA,
        history,
      )
    ).json(),
  );
  assert.equal(searchBody.includes('beta only token'), false);
  const fetchBody = JSON.stringify(
    await (
      await handleMCP(
        rpc('tools/call', { name: 'fetch', arguments: { id: hidden.id } }),
        sessionA,
        history,
      )
    ).json(),
  );
  assert.equal(fetchBody.includes('beta only token'), false);
  const statusBody = JSON.stringify(
    await (
      await handleMCP(
        rpc('tools/call', { name: 'status', arguments: {} }),
        sessionA,
        history,
      )
    ).json(),
  );
  assert.ok(
    /records\\?":0/.test(statusBody),
    statusBody.slice(0, 800),
  );

  const throughDispatch = await safeResponse(() =>
    dispatchMCP(rpc('tools/list'), profile('subject-a'), keys, history, pool),
  );
  assert.equal(throughDispatch.status, 200);
  const unbound = await safeResponse(() =>
    dispatchMCP(
      rpc('tools/list'),
      profile('subject-missing'),
      keys,
      history,
      pool,
    ),
  );
  assert.equal(unbound.status, 401);
  const viaKey = await safeResponse(() =>
    dispatchMCP(
      new Request('https://site.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + read.key,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'xylophone' } },
        }),
      }),
      null,
      keys,
      history,
      pool,
    ),
  );
  assert.equal(
    JSON.stringify(await viaKey.json()).includes('xylophone'),
    false,
  );
  const route = await readFile(
    new URL('../app/mcp/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /dispatchMCP\(/);
  assert.equal(route.includes('userId'), false);
});
