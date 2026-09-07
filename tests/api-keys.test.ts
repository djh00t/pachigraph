import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { migrate } from '../db/migrate.ts';
import { createKeys } from '../server/api-keys.ts';
import { clearStorage, testPool } from './storage-support.ts';

const pool = testPool();
before(async () => migrate(pool));
beforeEach(async () => clearStorage(pool));
after(async () => pool.end());

function request(path: string, method = 'GET', token?: string, body?: unknown) {
  return new Request('https://site.test' + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('keys are hashed, owner scoped, limited, expiring and revocable', async () => {
  const keys = createKeys(pool);
  const mint = (scope = 'read', token?: string) =>
    keys.manage(
      request('/api/keys', 'POST', token, { scope, days: 30 }),
      'alice',
    );

  assert.equal((await keys.manage(request('/api/keys'), null)).status, 401);
  const response = await mint('read', 'verified.jwt.token');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { key, id } = (await response.json()) as { key: string; id: string };
  assert.match(key, /^pg_[a-f0-9]{64}$/);
  assert.equal(
    (await pool.query('SELECT digest FROM pachigraph.api_keys')).rows[0]
      .digest === key,
    false,
  );
  for (const [path, method] of [
    ['/api/search', 'GET'],
    ['/api/fetch', 'GET'],
    ['/api/status', 'GET'],
    ['/mcp', 'POST'],
  ]) {
    assert.equal(await keys.resolve(request(path, method, key), null), 'alice');
  }
  await assert.rejects(
    keys.resolve(request('/api/ingest', 'POST', key), null),
    { status: 403 },
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
  await assert.rejects(keys.resolve(request('/api/search', 'GET', key), null), {
    status: 401,
  });

  const ingest = (await (await mint('ingest')).json()) as { key: string };
  assert.equal(
    await keys.resolve(request('/api/ingest', 'POST', ingest.key), null),
    'alice',
  );
  for (const [path, method] of [
    ['/api/search', 'GET'],
    ['/mcp', 'POST'],
    ['/api/thread', 'DELETE'],
  ]) {
    await assert.rejects(
      keys.resolve(request(path, method, ingest.key), null),
      {
        status: 403,
      },
    );
  }
  await pool.query("UPDATE pachigraph.api_keys SET scope = 'unknown'");
  await assert.rejects(
    keys.resolve(request('/api/ingest', 'POST', ingest.key), null),
    { status: 403 },
  );
  await pool.query('UPDATE pachigraph.api_keys SET expires_at = 0');
  await assert.rejects(
    keys.resolve(request('/api/ingest', 'POST', ingest.key), null),
    { status: 401 },
  );
});

test('management trusts only the verified owner and allows its JWT header', async () => {
  const keys = createKeys(pool);
  assert.equal(
    (
      await keys.manage(
        request('/api/keys', 'POST', 'verified.jwt.token', {
          scope: 'read',
          days: 1,
        }),
        'alice',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await keys.manage(
        request('/api/keys', 'POST', 'pg_' + 'a'.repeat(64), {
          scope: 'read',
          days: 1,
        }),
        'alice',
      )
    ).status,
    401,
  );
  const foreign = new Request('https://site.test/api/keys', {
    method: 'POST',
    headers: { origin: 'https://evil.test' },
  });
  assert.equal((await keys.manage(foreign, 'alice')).status, 403);
});
