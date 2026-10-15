import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/cross-platform/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

test('Codex repeated occurrences and partial voice preserve evidence boundaries', () => {
  const data = fixture('codex-voice');
  assert.equal(data.synthetic, true);
  const [codex, voice] = data.cases;
  assert.equal(codex.coverage, 'unknown');
  assert.equal(codex.records.length, 2);
  assert.deepEqual(codex.records[0], codex.records[1]);
  assert.equal(codex.records[0].id, undefined);
  assert.equal(codex.expectations.distinct_source_events, 2);
  assert.equal(voice.coverage, 'partial');
  assert.equal(voice.upstream_call_id, null);
  const entries = voice.record.active_transcript;
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].text, entries[1].text);
  assert.equal(voice.record.input_transcript, entries[1].text);
  for (const entry of entries) {
    assert.equal(entry.timestamp, undefined);
    assert.equal(entry.id, undefined);
  }
  assert.equal(voice.expectations.full_call_capture_established, false);
});

test('Claude missing source time and Pi native identity are not normalized away', () => {
  const data = fixture('claude-pi');
  assert.equal(data.synthetic, true);
  const [claude, pi, legacy] = data.cases;
  assert.equal(claude.source[0].timestamp, undefined);
  assert.equal(claude.expectations.original_timestamp, null);
  assert.equal(claude.expectations.full_raw_archive_coverage, 'unknown');
  assert.equal(pi.source[0].id, 'synthetic-session.alpha_1');
  const [, first, second] = pi.source;
  assert.match(first.id, /^[0-9a-f]{8}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.message.content, second.message.content);
  assert.notEqual(Date.parse(first.timestamp), first.message.timestamp);
  assert.equal(legacy.source[1].id, undefined);
  assert.equal(legacy.source[1].parentId, undefined);
  assert.equal(legacy.expectations.full_raw_archive_coverage, 'unknown');
});
