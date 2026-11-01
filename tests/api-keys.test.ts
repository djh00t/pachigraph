import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { migrate } from '../db/migrate.ts';
import { createKeys } from '../server/api-keys.ts';
import { sessionPrincipal, type VerifiedUser } from '../server/auth.ts';
import { clearStorage, testPool } from './storage-support.ts';

const pool = testPool();
const TENANT_A = 't-aaaaaaaaaaaaaaaa';
const TENANT_B = 't-bbbbbbbbbbbbbbbb';

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

function profile(subject: string): VerifiedUser {
  return {
    userId: subject,
    displayName: subject,
    email: '',
    fullName: null,
    expiresAt: new Date('2026-04-01T00:00:00.000Z'),
  };
}

async function bind(subject: string, tenant: string, active = true) {
  await pool.query(
    `INSERT INTO pachigraph.tenants (id, active, max_records, max_bytes)
     VALUES ($1, $2, 1000000, 10737418240)
     ON CONFLICT (id) DO NOTHING`,
    [tenant, active],
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_members (subject, tenant_id)
     VALUES ($1, $2)`,
    [subject, tenant],
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_usage (tenant_id, records, bytes)
     VALUES ($1, 0, 0)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant],
  );
}

async function session(subject: string, tenant: string) {
  await bind(subject, tenant);
  return sessionPrincipal(pool, profile(subject));
}

test('keys resolve to the creator tenant while that binding is active', async () => {
  const keys = createKeys(pool);
  const owner = await session('subject-a', TENANT_A);
  const response = await keys.manage(
    request('/api/keys', 'POST', 'verified.jwt.token', {
      scope: 'read',
      days: 30,
    }),
    owner,
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const minted = (await response.json()) as {
    key: string;
    id: string;
    expires_at: number;
  };
  assert.match(minted.key, /^pg_[a-f0-9]{64}$/);
  const stored = await pool.query<{ digest: string; tenant_id: string }>(
    'SELECT digest, tenant_id FROM pachigraph.api_keys',
  );
  assert.notEqual(stored.rows[0].digest, minted.key);
  assert.equal(stored.rows[0].tenant_id, TENANT_A);

  const resolved = await keys.resolve(
    request('/api/search', 'GET', minted.key),
  );
  assert.equal(resolved?.tenant, TENANT_A);
  assert.equal(resolved?.subject, 'subject-a');
  assert.equal(resolved?.scope, 'read');
  assert.deepEqual(resolved?.expiresAt, new Date(minted.expires_at));

  await bind('subject-b', TENANT_B);
  await pool.query(
    `UPDATE pachigraph.tenant_members SET tenant_id = $2 WHERE subject = $1`,
    ['subject-a', TENANT_B],
  );
  await assert.rejects(
    keys.resolve(request('/api/search', 'GET', minted.key)),
    { status: 401 },
  );
  await pool.query(
    `UPDATE pachigraph.tenant_members SET tenant_id = $2 WHERE subject = $1`,
    ['subject-a', TENANT_A],
  );
  await pool.query('DELETE FROM pachigraph.tenant_members WHERE subject = $1', [
    'subject-a',
  ]);
  await assert.rejects(
    keys.resolve(request('/api/search', 'GET', minted.key)),
    { status: 401 },
  );
  await bind('subject-a', TENANT_A);
  await pool.query(
    'UPDATE pachigraph.tenants SET active = false WHERE id = $1',
    [TENANT_A],
  );
  await assert.rejects(
    keys.resolve(request('/api/search', 'GET', minted.key)),
    { status: 401 },
  );
});

test('key scope matrix allows whoami for both scopes and rejects the rest', async () => {
  const keys = createKeys(pool);
  const owner = await session('subject-a', TENANT_A);
  const read = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'read', days: 7 }),
      owner,
    )
  ).json()) as { key: string };
  const ingest = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'ingest', days: 7 }),
      owner,
    )
  ).json()) as { key: string };
  const cells: Array<[string, string, string, number]> = [
    ['read', 'GET', '/api/search', 200],
    ['read', 'GET', '/api/fetch', 200],
    ['read', 'GET', '/api/status', 200],
    ['read', 'POST', '/mcp', 200],
    ['read', 'GET', '/api/whoami', 200],
    ['read', 'POST', '/api/ingest', 403],
    ['read', 'DELETE', '/api/thread', 403],
    ['read', 'GET', '/api/keys', 401],
    ['ingest', 'POST', '/api/ingest', 200],
    ['ingest', 'GET', '/api/whoami', 200],
    ['ingest', 'GET', '/api/search', 403],
    ['ingest', 'POST', '/mcp', 403],
    ['ingest', 'DELETE', '/api/thread', 403],
    ['ingest', 'GET', '/api/keys', 401],
  ];
  for (const [scope, method, path, status] of cells) {
    const token = scope === 'read' ? read.key : ingest.key;
    const call = keys.resolve(request(path, method, token));
    if (status === 200) {
      const principal = await call;
      assert.equal(principal?.scope, scope, `${scope} ${method} ${path}`);
    } else {
      await assert.rejects(call, { status }, `${scope} ${method} ${path}`);
    }
  }
  await pool.query("UPDATE pachigraph.api_keys SET scope = 'unknown'");
  await assert.rejects(
    keys.resolve(request('/api/ingest', 'POST', ingest.key)),
    { status: 403 },
  );
  await pool.query('UPDATE pachigraph.api_keys SET expires_at = 0');
  await assert.rejects(keys.resolve(request('/api/whoami', 'GET', read.key)), {
    status: 401,
  });
});

test('a subject lists and revokes only keys it created in its tenant', async () => {
  const keys = createKeys(pool);
  const ownerA = await session('subject-a', TENANT_A);
  const ownerB = await session('subject-b', TENANT_B);
  const minted = (await (
    await keys.manage(
      request('/api/keys', 'POST', undefined, { scope: 'read', days: 3 }),
      ownerB,
    )
  ).json()) as { id: string; key: string };
  assert.deepEqual(
    await (await keys.manage(request('/api/keys'), ownerA)).json(),
    [],
  );
  await keys.manage(request('/api/keys?id=' + minted.id, 'DELETE'), ownerA);
  assert.equal(
    (await keys.resolve(request('/api/search', 'GET', minted.key)))?.tenant,
    TENANT_B,
  );
  await keys.manage(request('/api/keys?id=' + minted.id, 'DELETE'), ownerB);
  await assert.rejects(
    keys.resolve(request('/api/search', 'GET', minted.key)),
    { status: 401 },
  );
});

test('an unbound subject gets 401 on list, create and revoke', async () => {
  const keys = createKeys(pool);
  const calls = [
    request('/api/keys'),
    request('/api/keys', 'POST', undefined, { scope: 'read', days: 1 }),
    request('/api/keys?id=00000000-0000-4000-8000-000000000001', 'DELETE'),
  ];
  for (const call of calls) {
    await assert.rejects(
      sessionPrincipal(pool, profile('subject-unbound')).then((principal) =>
        keys.manage(call, principal),
      ),
      { status: 401 },
    );
    assert.equal((await keys.manage(call, null)).status, 401);
  }
});

test('management trusts only the session principal and allows its JWT header', async () => {
  const keys = createKeys(pool);
  const owner = await session('subject-a', TENANT_A);
  assert.equal(
    (
      await keys.manage(
        request('/api/keys', 'POST', 'verified.jwt.token', {
          scope: 'read',
          days: 1,
        }),
        owner,
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
        owner,
      )
    ).status,
    401,
  );
  const foreign = new Request('https://site.test/api/keys', {
    method: 'POST',
    headers: { origin: 'https://evil.test' },
  });
  assert.equal((await keys.manage(foreign, owner)).status, 403);
});

test('missing authorization is not a key principal', async () => {
  const keys = createKeys(pool);
  assert.equal(await keys.resolve(request('/api/search')), null);
});
