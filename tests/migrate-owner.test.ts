import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { migrate } from '../db/migrate.ts';
import { testPool } from './storage-support.ts';

// Runs migrate() as a NOSUPERUSER role that owns schema pachigraph in a
// database where PUBLIC has no CREATE. This fails if migrate() issues any
// statement that needs database CREATE, such as CREATE SCHEMA IF NOT EXISTS.
const admin = testPool();
const suffix = randomBytes(8).toString('hex');
const database = `pachigraph_test_owner_db_${suffix}`;
const role = `pachigraph_test_owner_${suffix}`;
const password = randomBytes(24).toString('hex');
let isolated: Pool | undefined;
let owner: Pool | undefined;

function poolFor(user: string | null, secret: string | null): Pool {
  const url = new URL(process.env.PACHIGRAPH_TEST_DATABASE_URL ?? '');
  url.pathname = `/${database}`;
  if (user !== null && secret !== null) {
    url.username = user;
    url.password = secret;
  }
  return new Pool({ connectionString: url.toString(), max: 1 });
}

before(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.query(
    `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
  );
  isolated = poolFor(null, null);
  await isolated.query(
    `REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`,
  );
  await isolated.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await isolated.query(`CREATE SCHEMA pachigraph AUTHORIZATION ${role}`);
  owner = poolFor(role, password);
});

after(async () => {
  await owner?.end();
  await isolated?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});

test('migrate runs as a non-superuser schema owner without database CREATE', async () => {
  assert.ok(owner && isolated);
  const privileges = await owner.query<{ superuser: boolean; create: boolean }>(
    `SELECT rolsuper AS superuser,
            has_database_privilege(current_user, current_database(), 'CREATE') AS create
       FROM pg_roles WHERE rolname = current_user`,
  );
  assert.deepEqual(privileges.rows, [{ superuser: false, create: false }]);

  await migrate(owner);
  await migrate(owner);

  const foreign = await isolated.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pachigraph' AND pg_get_userbyid(c.relowner) <> $1`,
    [role],
  );
  assert.deepEqual(foreign.rows, []);
  const applied = await isolated.query(
    'SELECT count(*)::int AS count FROM pachigraph.schema_migrations',
  );
  assert.ok(applied.rows[0].count > 0);
});
