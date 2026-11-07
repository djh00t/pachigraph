import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// An early lint only. The database role's privileges are the security control.

const migrations = join(process.cwd(), 'db', 'migrations');
const forbidden = [
  /\bcreate\s+extension\b/i,
  /\bcreate\s+(?:role|user)\b/i,
  /\balter\s+(?:role|user|system)\b/i,
  /\bcreate\s+database\b/i,
  /\balter\s+database\b/i,
  /\bgrant\b[\s\S]*\bto\s+public\b/i,
  /\bcopy\b[\s\S]*\bprogram\b/i,
  /\bcreate\s+(?:or\s+replace\s+)?(?:trusted\s+)?(?:procedural\s+)?language\b/i,
  // A role assignment is privileged at a command boundary. The equals
  // sign alone cannot distinguish SET ROLE from an UPDATE assignment.
  /\bset\s+(?:(?:session|local)\s+)?(?:role\b(?!\s*[=.[])|session\s+authorization\b)/i,
  /(?:^|\b(?:begin|then|else|loop)\s+|\bexecute\s+['"]\s*)set\s+(?:(?:session|local)\s+)?role\s*=/i,
];

function statements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function hasForbiddenStatement(sql: string): boolean {
  return statements(sql).some((statement) =>
    forbidden.some((pattern) => pattern.test(statement)),
  );
}

test('migration policy matcher rejects privileged SQL', () => {
  for (const sql of [
    'CREATE EXTENSION pgcrypto;',
    'CREATE ROLE app;',
    'ALTER USER app;',
    'ALTER SYSTEM SET work_mem = 1;',
    'CREATE DATABASE app;',
    'ALTER DATABASE app;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA pachigraph TO PUBLIC;',
    "COPY data FROM PROGRAM 'true';",
    'CREATE LANGUAGE plpgsql;',
    'SET ROLE app;',
    'SET SESSION AUTHORIZATION app;',
    'SET LOCAL ROLE app;',
    'SELECT 1; CREATE ROLE app;',
    '-- a note\nCREATE ROLE app;',
    '/* a note */ create role app;',
    "DO $$ BEGIN EXECUTE 'CREATE ROLE app'; END $$;",
    'DO $$ BEGIN CREATE ROLE app; END $$;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA pachigraph GRANT SELECT ON TABLES TO PUBLIC;',
    'CREATE TRUSTED LANGUAGE plsample;',
    'CREATE OR REPLACE PROCEDURAL LANGUAGE plsample;',
  ]) {
    assert.equal(hasForbiddenStatement(sql), true, sql);
  }
  for (const sql of [
    'CREATE TABLE pachigraph.example (id int);',
    'SET search_path TO pachigraph;',
    'DO $$ BEGIN SET LOCAL search_path TO pachigraph; END $$;',
    "DO $$ BEGIN EXECUTE 'UPDATE pachigraph.members SET role = ''owner'''; END $$;",
    "UPDATE pachigraph.members SET role = 'owner';",
    "UPDATE pachigraph.members SET role[1] = 'owner';",
    "UPDATE pachigraph.members SET role.name = 'owner';",
    'ALTER TABLE pachigraph.members ADD COLUMN role text;',
    '-- CREATE ROLE app;\nSELECT 1;',
    '/* GRANT SELECT ON t TO PUBLIC; */ SELECT 1;',
  ]) {
    assert.equal(hasForbiddenStatement(sql), false, sql);
  }
});

for (const command of [
  'CREATE EXTENSION pgcrypto',
  'ALTER ROLE app',
  'ALTER USER app',
  'ALTER SYSTEM SET work_mem = 1',
  'CREATE DATABASE app',
  'ALTER DATABASE app',
  "COPY data FROM PROGRAM 'true'",
  'CREATE LANGUAGE plpgsql',
  'SET ROLE app',
  "SET ROLE = 'app'",
  'SET SESSION AUTHORIZATION app',
  'SET LOCAL ROLE app',
  'SET SESSION ROLE app',
]) {
  test(`migration policy rejects wrapped ${command}`, () => {
    assert.equal(
      hasForbiddenStatement(`DO $$ BEGIN ${command}; END $$;`),
      true,
    );
    const escaped = command.replaceAll("'", "''");
    assert.equal(
      hasForbiddenStatement(`DO $$ BEGIN EXECUTE '${escaped}'; END $$;`),
      true,
    );
  });
}

test('SQL migrations avoid privileged statements', () => {
  for (const filename of readdirSync(migrations).filter((name) =>
    name.endsWith('.sql'),
  )) {
    const sql = readFileSync(join(migrations, filename), 'utf8');
    assert.equal(hasForbiddenStatement(sql), false, filename);
  }
});
