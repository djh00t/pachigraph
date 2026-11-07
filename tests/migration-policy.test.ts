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
];

function statements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// Keep literal text whole, including semicolons.
// shortcut: only literal DO and EXECUTE, revisit if migrations need computed or encoded role SQL.
const sqlToken = new RegExp(
  [
    String.raw`--[^\r\n]*|/\*[\s\S]*?\*/`,
    String.raw`[Ee]'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'`,
    String.raw`(?<tag>\$(?:[A-Za-z_]\w*)?\$)[\s\S]*?\k<tag>`,
    String.raw`"(?:""|[^"])*"|[A-Za-z_][\w$]*|\S`,
  ].join('|'),
  'g',
);
const roleCommand =
  /^set\s+(?:(?:session|local)\s+)?(?:(?:role|"role")(?!\s+\.)(?:\s|$)|session\s+authorization\b)/i;
const blockBoundaries = new Map([
  ['begin', ['begin', 'declare']],
  ['then', ['if', 'elsif', 'elseif', 'case', 'when', 'exception']],
  ['else', ['else']],
  ['loop', ['loop', 'for', 'foreach', 'while']],
]);
const executeClauses = new Set([';', 'into', 'using']);
const escapedCharacters: Readonly<Record<string, string>> = {
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

function literalText(token = ''): string | undefined {
  if (token.startsWith('$') && token.length > 1) {
    const delimiterLength = token.indexOf('$', 1) + 1;
    return token.slice(delimiterLength, -delimiterLength);
  }
  if (token.startsWith("'") && token.length > 1) {
    return token.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[Ee]'/.test(token)) {
    return token.slice(2, -1).replace(
      /''|\\([\s\S])/g,
      (_match, escape: string | undefined) =>
        escape === undefined ? "'" : escapedCharacters[escape] ?? escape,
    );
  }
  return undefined;
}

function hasRoleCommand(sql: string, procedural = false): boolean {
  const tokens = (sql.match(sqlToken) ?? []).filter(
    (token) => !token.startsWith('--') && !token.startsWith('/*'),
  );
  let boundary = true;
  let firstWord = '';
  for (const [index, token] of tokens.entries()) {
    const word = token.toLowerCase();
    const next = tokens[index + 1];
    if (boundary) {
      firstWord = word;
      if (word === 'set' && roleCommand.test(tokens.slice(index, index + 4).join(' '))) {
        return true;
      }
      if (word === 'do') {
        const body = literalText(
          next?.toLowerCase() === 'language' ? tokens[index + 3] : next,
        );
        if (body !== undefined && hasRoleCommand(body, true)) return true;
      }
      if (procedural && word === 'execute') {
        const command = literalText(next);
        const after = tokens[index + 2]?.toLowerCase();
        if (
          command !== undefined &&
          (after === undefined || executeClauses.has(after)) &&
          hasRoleCommand(command)
        ) {
          return true;
        }
      }
    }
    boundary = word === ';' ||
      (procedural && blockBoundaries.get(word)?.includes(firstWord) === true);
  }
  return false;
}

function hasForbiddenStatement(sql: string): boolean {
  return hasRoleCommand(sql) || statements(sql).some((statement) =>
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

for (const [name, sql] of [
  ['direct role assignment', "SET ROLE = 'app';"],
  ['tagged EXECUTE string', "DO $do$ BEGIN EXECUTE $$SET ROLE = 'app'$$; END $do$;"],
  ['escaped EXECUTE string', String.raw`DO $$ BEGIN EXECUTE E'SET ROLE = \'app\''; END $$;`],
  ['commented boundary', 'DO $$ BEGIN /* note */ SET ROLE app; END $$;'],
  ['conditional boundary', 'DO $$ BEGIN IF true THEN SET ROLE app; END IF; END $$;'],
  ['escaped command whitespace', String.raw`DO $$ BEGIN EXECUTE E'SET\tROLE app'; END $$;`],
  ['second command in a constant', "DO $$ BEGIN EXECUTE 'SELECT 1; SET ROLE app'; END $$;"],
]) {
  test(`migration policy detects ${name}`, () => {
    assert.equal(hasForbiddenStatement(sql), true);
  });
}

for (const [name, sql] of [
  ['SET with role text', "SET application_name TO 'SET ROLE app';"],
  ['UPDATE with role text and semicolons', "UPDATE pachigraph.members SET role = 'before; SET ROLE app';"],
  ['DO with a notice', "DO $$ BEGIN RAISE NOTICE 'before; SET ROLE app'; END $$;"],
  ['EXECUTE with role text as data', "DO $do$ BEGIN EXECUTE $$UPDATE pachigraph.members SET role = 'before; SET ROLE app'$$; END $do$;"],
  ['computed EXECUTE text', "DO $$ BEGIN EXECUTE 'SET ROLE app' || role_suffix; END $$;"],
  ['procedural keyword as table name', "DO $$ BEGIN UPDATE loop SET role = 'owner'; END $$;"],
]) {
  test(`migration policy allows ${name}`, () => {
    assert.equal(hasForbiddenStatement(sql), false);
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
