import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// An early lint only. The database role's privileges are the security control.

const migrations = join(process.cwd(), 'db', 'migrations');
// Each pattern must match at the start of a statement, after comments are
// removed, so column names such as `SET role = ...` and comments do not count.
const forbidden = [
  /^create\s+extension\b/i,
  /^create\s+(?:role|user)\b/i,
  /^alter\s+(?:role|user|system)\b/i,
  /^create\s+database\b/i,
  /^alter\s+database\b/i,
  /^grant\b[\s\S]*\bto\s+public\b/i,
  /^copy\b[\s\S]*\bprogram\b/i,
  /^create\s+(?:or\s+replace\s+)?(?:trusted\s+)?(?:procedural\s+)?language\b/i,
  /^set\s+(?:(?:session|local)\s+)?(?:role|session\s+authorization)\b/i,
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
  ]) {
    assert.equal(hasForbiddenStatement(sql), true, sql);
  }
  for (const sql of [
    'CREATE TABLE pachigraph.example (id int);',
    "UPDATE pachigraph.members SET role = 'owner';",
    'ALTER TABLE pachigraph.members ADD COLUMN role text;',
    '-- CREATE ROLE app;\nSELECT 1;',
    '/* GRANT SELECT ON t TO PUBLIC; */ SELECT 1;',
  ]) {
    assert.equal(hasForbiddenStatement(sql), false, sql);
  }
});

test('SQL migrations avoid privileged statements', () => {
  for (const filename of readdirSync(migrations).filter((name) =>
    name.endsWith('.sql'),
  )) {
    const sql = readFileSync(join(migrations, filename), 'utf8');
    assert.equal(hasForbiddenStatement(sql), false, filename);
  }
});
