import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';

import { migrate } from '../db/migrate.ts';
import { createKeys } from '../server/api-keys.ts';
import { sessionPrincipal, type VerifiedUser } from '../server/auth.ts';
import { clearStorage, testPool } from './storage-support.ts';

const pool = testPool();
const url = process.env.PACHIGRAPH_TEST_DATABASE_URL ?? '';

before(async () => migrate(pool));
beforeEach(async () => clearStorage(pool));
after(async () => pool.end());

function cli(args: string[]) {
  return spawnSync(process.execPath, ['scripts/tenant.ts', ...args], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
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

test('create refuses a supplied id, an email and a bound subject', async () => {
  const created = cli(['create']);
  assert.equal(created.status, 0);
  const id = created.stdout.trim();
  assert.match(id, /^t-[0-9a-f]{16}$/);
  assert.equal(cli(['create', id]).status, 2);
  assert.equal(cli(['create', 'archive@example.test']).status, 2);
  assert.equal(cli(['bind', 'subject-a', id]).status, 0);
  assert.equal(cli(['create', 'subject-a']).status, 2);
  const again = cli(['create']);
  assert.equal(again.status, 0);
  assert.notEqual(again.stdout.trim(), id);
});

test('list hides subjects unless asked, and quota and deactivate update the tenant', async () => {
  const id = cli(['create']).stdout.trim();
  assert.equal(cli(['bind', 'subject-a', id]).status, 0);
  const hidden = cli(['list']);
  assert.equal(hidden.status, 0);
  assert.equal(hidden.stdout.includes('subject-a'), false);
  assert.match(hidden.stdout, new RegExp(`${id}\\tactive=true\\tmembers=1`));
  const shown = cli(['list', '--subjects']);
  assert.equal(shown.stdout.includes(`subjects=subject-a`), true);
  assert.equal(cli(['quota', id, '10', '20']).status, 0);
  assert.equal(cli(['deactivate', id]).status, 0);
  const row = await pool.query<{
    active: boolean;
    max_records: string;
    max_bytes: string;
  }>(
    'SELECT active, max_records::text, max_bytes::text FROM pachigraph.tenants WHERE id = $1',
    [id],
  );
  assert.equal(row.rows[0].active, false);
  assert.equal(row.rows[0].max_records, '10');
  assert.equal(row.rows[0].max_bytes, '20');
});

test('bind, rebind and unbind keep one subject on an existing tenant', async () => {
  const first = cli(['create']).stdout.trim();
  const second = cli(['create']).stdout.trim();
  assert.equal(cli(['bind', 'subject-a', 't-' + '0'.repeat(16)]).status, 2);
  assert.equal(cli(['bind', 'subject-a', first]).status, 0);
  assert.equal(cli(['bind', 'subject-a', second]).status, 2);
  assert.equal(cli(['rebind', 'subject-a', second]).status, 0);
  const names = await pool.query<{ id: string }>(
    'SELECT id FROM pachigraph.tenants ORDER BY id',
  );
  assert.deepEqual(
    names.rows.map((row) => row.id).sort(),
    [first, second].sort(),
  );
  const member = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM pachigraph.tenant_members WHERE subject = $1',
    ['subject-a'],
  );
  assert.equal(member.rows[0].tenant_id, second);

  const keys = createKeys(pool);
  const owner = await sessionPrincipal(pool, profile('subject-a'));
  const minted = (await (
    await keys.manage(
      new Request('https://site.test/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'read', days: 1 }),
      }),
      owner,
    )
  ).json()) as { key: string };
  assert.equal(cli(['unbind', 'subject-a']).status, 0);
  await assert.rejects(
    keys.resolve(
      new Request('https://site.test/api/search', {
        headers: { authorization: 'Bearer ' + minted.key },
      }),
    ),
    { status: 401 },
  );
  assert.equal(cli(['bind', 'subject-a', second]).status, 0);
  assert.equal(cli(['rebind', 'subject-a', first]).status, 0);
  await assert.rejects(
    keys.resolve(
      new Request('https://site.test/api/search', {
        headers: { authorization: 'Bearer ' + minted.key },
      }),
    ),
    { status: 401 },
  );
  const remaining = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM pachigraph.api_keys WHERE owner_id = $1',
    ['subject-a'],
  );
  assert.equal(remaining.rows[0].count, 0);
});

test('create rolls back the tenant when usage cannot be recorded', async () => {
  await pool.query(`
    CREATE FUNCTION pachigraph.reject_usage_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected usage failure'; END $$;
    CREATE TRIGGER reject_usage_insert BEFORE INSERT ON pachigraph.tenant_usage
    FOR EACH ROW EXECUTE FUNCTION pachigraph.reject_usage_insert()
  `);
  try {
    const before = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pachigraph.tenants',
    );
    const result = cli(['create']);
    assert.notEqual(result.status, 0);
    const after = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pachigraph.tenants',
    );
    assert.equal(after.rows[0].count, before.rows[0].count);
  } finally {
    await pool.query(`
      DROP TRIGGER IF EXISTS reject_usage_insert ON pachigraph.tenant_usage;
      DROP FUNCTION IF EXISTS pachigraph.reject_usage_insert()
    `);
  }
});
