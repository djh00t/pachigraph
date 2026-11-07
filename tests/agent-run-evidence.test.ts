import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareHistoryRecords } from '../server/history.ts';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/agent-run/synthetic-run.json', import.meta.url),
    'utf8',
  ),
);

const owner = 'synthetic-owner';

test('synthetic run evidence satisfies the immutable history envelope', () => {
  const prepared = prepareHistoryRecords(owner, fixture);
  assert.equal(prepared.length, fixture.records.length);
  assert.ok(prepared.every((record) => /^[0-9a-f]{64}$/.test(record.id)));
  assert.ok(prepared.every((record) => /^[0-9a-f]{64}$/.test(record.revision)));
  assert.ok(
    prepared.every((record) =>
      record.key.startsWith(`${prepared[0]?.key.split('/')[0]}/`),
    ),
  );
  assert.deepEqual(
    prepared.map((record) => record.item.record.sequence),
    Array.from({ length: fixture.records.length }, (_, index) => index + 1),
  );
  assert.deepEqual(
    [
      ...new Set(prepared.map((record) => record.item.record.attempt_id)),
    ].sort(),
    ['attempt-001', 'attempt-002'],
  );
  const events = prepared.map(
    (record) => record.item.record as Record<string, unknown>,
  );
  const secondAttempt = events.find(
    (event) => event.event_type === 'attempt.started',
  );
  assert.equal(secondAttempt?.parent_attempt_id, 'attempt-001');
  assert.deepEqual(
    events.find((event) => event.event_type === 'context.packet')
      ?.ordered_source_refs,
    [
      'repo://synthetic/src/main.ts@rev-03',
      'repo://synthetic/tests/main.test.ts@rev-04',
    ],
  );
  assert.equal(
    events.find((event) => event.event_type === 'context.packet')
      ?.supersedes_projection_revision,
    'projection-01',
  );
  assert.equal(
    events.filter((event) => event.event_type === 'model.call').length,
    2,
  );
  assert.equal(
    events.filter((event) => event.event_type === 'tool.call.completed').length,
    2,
  );
  assert.equal(
    events.find((event) => event.event_type === 'trace.span')?.span_id,
    'span-004',
  );
  assert.equal(
    events.find((event) => event.event_type === 'artifact.created')
      ?.artifact_id,
    'artifact-001',
  );
  assert.deepEqual(
    new Set(events.map((event) => event.event_type)),
    new Set([
      'run.started',
      'model.call',
      'transcript.message',
      'tool.call.completed',
      'trace.span',
      'attempt.started',
      'context.packet',
      'artifact.created',
      'usage.observation',
    ]),
  );
  assert.deepEqual(
    prepared
      .map((record) => {
        const event = record.item.record as {
          usage?: { coverage?: string };
          event_type?: string;
          coverage?: string;
        };
        return (
          event.usage?.coverage ??
          (event.event_type === 'usage.observation'
            ? event.coverage
            : undefined)
        );
      })
      .filter((coverage) => coverage !== undefined)
      .sort(),
    ['redacted', 'reported', 'unavailable'],
  );
});

test('replay identities are deterministic and owner scoped', () => {
  const first = prepareHistoryRecords(owner, fixture);
  const replay = prepareHistoryRecords(owner, fixture);
  const otherOwner = prepareHistoryRecords('other-owner', fixture);

  assert.deepEqual(
    replay.map(({ id, revision, key }) => ({ id, revision, key })),
    first.map(({ id, revision, key }) => ({ id, revision, key })),
  );
  assert.ok(
    first.every((record, index) => record.id !== otherOwner[index]?.id),
  );
  assert.ok(
    first.every((record, index) => record.key !== otherOwner[index]?.key),
  );
});

test('fixture validation uses the production envelope limits', () => {
  const invalid = structuredClone(fixture);
  invalid.records[0].id = 'not-a-sha256';
  assert.throws(() => prepareHistoryRecords(owner, invalid), {
    message: 'record id, timestamp, or text is invalid',
  });
});
