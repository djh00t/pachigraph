import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { createKeys } from '../server/api-keys.ts';

test('keys are hashed, owner scoped, limited, expiring and revocable', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    readFileSync(
      new URL('../drizzle/0002_graceful_mysterio.sql', import.meta.url),
      'utf8',
    ),
  );
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          return this;
        },
        async run() {
          return sqlite.prepare(sql).run(...values);
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
      };
    },
  } as unknown as D1Database;
  const keys = createKeys(db);
  const request = (
    path: string,
    method = 'GET',
    token?: string,
    body?: unknown,
  ) =>
    new Request('https://site.test' + path, {
      method,
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const mint = (scope = 'read') =>
    keys.manage(
      request('/api/keys', 'POST', undefined, { scope, days: 30 }),
      'alice',
    );
  try {
    assert.equal((await keys.manage(request('/api/keys'), null)).status, 401);
    const response = await mint();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { key, id } = (await response.json()) as { key: string; id: string };
    assert.match(key, /^pg_[a-f0-9]{64}$/);
    assert.ok(
      !JSON.stringify(sqlite.prepare('SELECT * FROM api_keys').all()).includes(
        key,
      ),
    );
    assert.equal(
      await keys.resolve(request('/api/search', 'GET', key), 'bob'),
      'alice',
    );
    assert.equal(
      await keys.resolve(request('/mcp', 'POST', key), null),
      'alice',
    );
    await assert.rejects(
      keys.resolve(request('/api/ingest', 'POST', key), null),
      { status: 403 },
    );
    await assert.rejects(
      keys.resolve(request('/api/search', 'GET', 'bad'), 'alice'),
      { status: 401 },
    );
    assert.equal(
      (await keys.manage(request('/api/keys', 'GET', key), 'alice')).status,
      401,
    );
    assert.deepEqual(
      await (await keys.manage(request('/api/keys'), 'bob')).json(),
      [],
    );
    await keys.manage(request('/api/keys?id=' + id, 'DELETE'), 'bob');
    assert.equal(
      await keys.resolve(request('/api/search', 'GET', key), null),
      'alice',
    );
    await keys.manage(request('/api/keys?id=' + id, 'DELETE'), 'alice');
    await assert.rejects(
      keys.resolve(request('/api/search', 'GET', key), null),
      { status: 401 },
    );
    const ingest = (await (await mint('ingest')).json()) as { key: string };
    assert.equal(
      await keys.resolve(request('/api/ingest', 'POST', ingest.key), null),
      'alice',
    );
    await assert.rejects(
      keys.resolve(request('/api/thread', 'DELETE', ingest.key), null),
      { status: 403 },
    );
    for (const path of ['/api/search', '/api/fetch', '/api/status', '/mcp']) {
      await assert.rejects(
        keys.resolve(
          request(path, path === '/mcp' ? 'POST' : 'GET', ingest.key),
          null,
        ),
        { status: 403 },
      );
    }
    sqlite.prepare("UPDATE api_keys SET scope = 'unknown'").run();
    await assert.rejects(
      keys.resolve(request('/api/ingest', 'POST', ingest.key), null),
      { status: 403 },
    );
    sqlite.prepare('UPDATE api_keys SET expires_at = 0').run();
    await assert.rejects(
      keys.resolve(request('/api/ingest', 'POST', ingest.key), null),
      { status: 401 },
    );
    const foreign = new Request('https://site.test/api/keys', {
      method: 'POST',
      headers: { origin: 'https://evil.test' },
    });
    assert.equal((await keys.manage(foreign, 'alice')).status, 403);
  } finally {
    sqlite.close();
  }
});
