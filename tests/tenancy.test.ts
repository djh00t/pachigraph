import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { after, before, beforeEach, test } from 'node:test';

import { loadArchive, SourceEvidence } from '../app/archive.ts';
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
  assert.ok(/records\\?":0/.test(statusBody), statusBody.slice(0, 800));

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

test('a version-5 thread is labelled as a ChatGPT import', () => {
  const v5 = '018f47a8-4af3-5b83-8f0e-6f2b4e955c12';
  const v7 = '018f47a8-4af3-7b83-bf0e-6f2b4e955c12';
  const imported = renderToStaticMarkup(
    createElement(SourceEvidence, {
      threadId: v5,
      citation: `ChatGPT conversation ${v5}, event ${'a'.repeat(64)}, 2026-09-05T01:02:03.000Z; /?id=record`,
    }),
  );
  assert.equal(imported.includes('Imported from a ChatGPT export'), true);
  assert.equal(imported.includes('codex://'), false);
  assert.equal(imported.includes('Opening the original requires Codex'), false);
  const codex = renderToStaticMarkup(
    createElement(SourceEvidence, {
      threadId: v7,
      citation: `Codex thread ${v7}, event event, 2026-09-05T01:02:03.000Z; /?id=record; codex://threads/${v7}#event`,
    }),
  );
  assert.equal(codex.includes('href="codex://threads/' + v7), true);
  assert.equal(codex.includes('Opening the original requires Codex'), true);
  assert.equal(codex.includes('Imported from a ChatGPT export'), false);
});

test('cross-tenant data stays inside each entry point', async () => {
  const objects = new MemoryObjects();
  const history = createHistory(pool, objects);
  const { sessionA, sessionB } = await principals();
  const token = 'beta-only-token';
  await history.ingest(sessionB.tenant, {
    thread_id: THREAD,
    records: [
      {
        id: SOURCE,
        timestamp: '2026-09-05T01:02:03.000Z',
        text: token,
        record: { side: 'beta' },
      },
    ],
  });
  const hidden = (await history.search(sessionB.tenant, token)).results[0] as {
    id: string;
  };
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
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
      request('/api/search?q=' + token),
      sessionA,
      history,
    );
    const searchBody = await search.text();
    assert.equal(searchBody.includes(token), false);
    assert.equal(searchBody.includes(hidden.id), false);
    assert.equal(searchBody.includes(TENANT_B), false);
    const status = (await (
      await handleAPI(request('/api/status'), sessionA, history)
    ).json()) as { records: number };
    assert.equal(status.records, 0);
    const viaRoute = await safeResponse(() =>
      dispatchAPI(
        request('/api/search?q=' + token),
        profile('subject-a'),
        createKeys(pool),
        history,
        pool,
      ),
    );
    assert.equal((await viaRoute.text()).includes(token), false);
    const pageMissing = await loadArchive(sessionA.tenant, history, {
      id: 'f'.repeat(64),
      q: token,
    });
    const pageForeign = await loadArchive(sessionA.tenant, history, {
      id: hidden.id,
      q: token,
    });
    assert.equal(pageForeign.fetchError, pageMissing.fetchError);
    assert.deepEqual(pageForeign.results, []);
    assert.equal(pageForeign.selected, null);
    const keys = createKeys(pool);
    const read = (await (
      await keys.manage(
        request('/api/keys', 'POST', undefined, { scope: 'read', days: 2 }),
        sessionA,
      )
    ).json()) as { key: string };
    const mcpBody = JSON.stringify(
      await (
        await handleMCP(
          rpc('tools/call', { name: 'search', arguments: { query: token } }),
          sessionA,
          history,
        )
      ).json(),
    );
    assert.equal(mcpBody.includes(token), false);
    const mcpRoute = await safeResponse(() =>
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
            params: { name: 'search', arguments: { query: token } },
          }),
        }),
        null,
        keys,
        history,
        pool,
      ),
    );
    assert.equal(JSON.stringify(await mcpRoute.json()).includes(token), false);
    await history.ingest(sessionA.tenant, {
      thread_id: THREAD,
      records: [
        {
          id: SOURCE,
          timestamp: '2026-09-05T01:02:03.000Z',
          text: 'stored only for subject-a',
          record: { side: 'alpha' },
        },
      ],
    });
    assert.equal((await history.status(sessionB.tenant)).records, 1);
    const other = '018f47a8-4af3-7b83-bf0e-6f2b4e955c99';
    await history.ingest(sessionB.tenant, {
      thread_id: other,
      records: [
        {
          id: 'c'.repeat(64),
          timestamp: '2026-09-05T01:02:03.000Z',
          text: 'other thread',
          record: { side: 'beta' },
        },
      ],
    });
    await history.deleteThread(sessionB.tenant, other);
    await history.ingest(sessionA.tenant, {
      thread_id: THREAD,
      records: [
        {
          id: 'd'.repeat(64),
          timestamp: '2026-09-06T01:02:03.000Z',
          text: 'not blocked by the other tenant',
          record: { side: 'alpha' },
        },
      ],
    });
    assert.equal(
      (await handleAPI(request('/api/thread?id=' + THREAD, 'DELETE'), sessionA, history)).status,
      200,
    );
    assert.equal((await history.search(sessionB.tenant, token)).results.length, 1);
  } finally {
    console.error = originalError;
  }
  const joined = logs.join('\n');
  assert.equal(joined.includes(TENANT_B), false);
  assert.equal(joined.includes(hidden.id), false);
});

test('scope matrix, one gate and quota hold on the HTTP entry points', async () => {
  const objects = new MemoryObjects();
  const history = createHistory(pool, objects);
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
  const record = {
    id: 'b'.repeat(64),
    timestamp: '2026-09-05T01:02:03.000Z',
    text: 'matrix',
    record: { ok: true },
  };
  const matrix = [
    {
      route: 'GET /api/search, GET /api/fetch, GET /api/status',
      calls: ['/api/search?q=matrix', '/api/fetch?id=' + 'e'.repeat(64), '/api/status'],
      method: 'GET' as const,
      read: 200,
      ingest: 403,
      session: 200,
    },
    {
      route: 'POST /mcp',
      calls: ['/mcp'],
      method: 'POST' as const,
      read: 200,
      ingest: 403,
      session: 200,
      mcp: true,
    },
    {
      route: 'POST /api/ingest',
      calls: ['/api/ingest'],
      method: 'POST' as const,
      body: { thread_id: THREAD, records: [record] },
      read: 403,
      ingest: 200,
      session: 403,
    },
    {
      route: 'GET /api/whoami',
      calls: ['/api/whoami'],
      method: 'GET' as const,
      read: 200,
      ingest: 200,
      session: 200,
    },
    {
      route: 'DELETE /api/thread',
      calls: ['/api/thread?id=' + THREAD],
      method: 'DELETE' as const,
      read: 403,
      ingest: 403,
      session: 200,
    },
    {
      route: '/api/keys',
      calls: ['/api/keys'],
      method: 'GET' as const,
      read: 401,
      ingest: 401,
      session: 200,
    },
  ];
  assert.equal(matrix.length, 6);
  for (const row of matrix) {
    for (const path of row.calls) {
      for (const actor of ['read', 'ingest', 'session'] as const) {
        const expected =
          path.startsWith('/api/fetch') && row[actor] === 200 ? 404 : row[actor];
        const user = actor === 'session' ? profile('subject-a') : null;
        const token =
          actor === 'read' ? read.key : actor === 'ingest' ? ingest.key : undefined;
        const response = row.mcp
          ? await safeResponse(() =>
              dispatchMCP(
                new Request('https://site.test/mcp', {
                  method: 'POST',
                  headers: {
                    ...(token ? { authorization: 'Bearer ' + token } : {}),
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                  },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'status', arguments: {} },
                  }),
                }),
                user,
                keys,
                history,
                pool,
              ),
            )
          : await safeResponse(() =>
              dispatchAPI(
                request(path, row.method, token, 'body' in row ? row.body : undefined),
                user,
                keys,
                history,
                pool,
              ),
            );
        assert.equal(response.status, expected, `${row.route} ${actor} ${path}`);
        if (expected === 403)
          assert.equal((await response.json()).error, 'Scope not allowed');
        if (path === '/api/whoami' && expected === 200) {
          const body = WhoamiResponse.parse(await response.json());
          assert.equal(body.scope, actor);
          assert.equal(body.tenant, TENANT_A);
          assert.equal(response.headers.get('cache-control'), 'no-store');
        }
      }
    }
  }
  assert.equal(
    (
      await safeResponse(() =>
        dispatchAPI(request('/api/status'), profile('subject-missing'), keys, history, pool),
      )
    ).status,
    401,
  );
  await pool.query(`UPDATE pachigraph.tenants SET active = false WHERE id = $1`, [TENANT_A]);
  assert.equal(
    (
      await safeResponse(() =>
        dispatchAPI(request('/api/status'), profile('subject-a'), keys, history, pool),
      )
    ).status,
    401,
  );
  await pool.query(`UPDATE pachigraph.tenants SET active = true WHERE id = $1`, [TENANT_A]);
  await pool.query(`DELETE FROM pachigraph.tenant_members WHERE subject = 'subject-a'`);
  assert.equal(
    (
      await safeResponse(() =>
        dispatchAPI(request('/api/keys'), profile('subject-a'), keys, history, pool),
      )
    ).status,
    401,
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_members (subject, tenant_id) VALUES ('subject-a', $1)`,
    [TENANT_A],
  );
  await pool.query(`DELETE FROM pachigraph.tenant_members WHERE subject = 'subject-a'`);
  assert.equal(
    (
      await safeResponse(() =>
        dispatchAPI(request('/api/whoami', 'GET', read.key), null, keys, history, pool),
      )
    ).status,
    401,
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_members (subject, tenant_id) VALUES ('subject-a', $1)`,
    [TENANT_A],
  );
  // Removing a subject from the allowlist blocks new sign-in only. It is not the gate.
  assert.equal(
    (
      await safeResponse(() =>
        dispatchAPI(request('/api/status'), profile('subject-a'), keys, history, pool),
      )
    ).status,
    200,
  );
  await pool.query(`UPDATE pachigraph.tenants SET max_records = 0 WHERE id = $1`, [TENANT_A]);
  const before = objects.objects.size;
  const quota = await safeResponse(() =>
    dispatchAPI(
      request('/api/ingest', 'POST', ingest.key, {
        thread_id: '018f47a8-4af3-7b83-bf0e-6f2b4e955c98',
        records: [{ ...record, id: '9'.repeat(64) }],
      }),
      null,
      keys,
      history,
      pool,
    ),
  );
  assert.equal(quota.status, 507);
  assert.equal((await quota.json()).error, 'Storage quota exceeded');
  assert.equal(objects.objects.size, before);
});
