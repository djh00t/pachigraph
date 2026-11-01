import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migrations = join(process.cwd(), 'db', 'migrations');
const forbidden = [
  /\bcreate\s+extension\b/i,
  /\bcreate\s+(?:role|user)\b/i,
  /\balter\s+(?:role|user|system)\b/i,
  /\bcreate\s+database\b/i,
  /\balter\s+database\b/i,
  /\bgrant\b[^;]*\bto\s+public\b/i,
  /\bcopy\b[^;]*\bprogram\b/i,
  /\bcreate\s+language\b/i,
  /\bset\s+(?:role|session\s+authorization)\b/i,
  /\b(?!pachigraph\b)[a-z_][a-z0-9_$]*\s*\./i,
];

function hasForbiddenStatement(sql: string): boolean {
  return forbidden.some((pattern) => pattern.test(sql));
}

test('migration policy matcher rejects privileged SQL and other schemas', () => {
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
    'CREATE TABLE public.example (id int);',
  ]) {
    assert.equal(hasForbiddenStatement(sql), true, sql);
  }
  assert.equal(
    hasForbiddenStatement('CREATE TABLE pachigraph.example (id int);'),
    false,
  );
});

test('all SQL migrations use only the pachigraph schema and allowed statements', () => {
  for (const filename of readdirSync(migrations).filter((name) =>
    name.endsWith('.sql'),
  )) {
    const sql = readFileSync(join(migrations, filename), 'utf8');
    assert.equal(hasForbiddenStatement(sql), false, filename);
  }
});
