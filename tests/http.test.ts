import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleAPI, readJSON, safeResponse } from '../server/http.ts';

const calls: unknown[] = [];
const history = {
  search: async (owner: string, q: string) => {
    calls.push([owner, q]);
    return { results: [] };
  },
  fetch: async () => {
    throw Object.assign(new Error('private database detail'), { status: 404 });
  },
  ingest: async (owner: string, body: unknown) => {
    calls.push([owner, body]);
    return { stored: 1, duplicate: 0 };
  },
  deleteThread: async (owner: string, id: string) => {
    calls.push([owner, id]);
    return { deleted: true };
  },
  status: async () => ({
    threads: 0,
    records: 0,
    text_bytes: 0,
    last_ingested_at: null,
  }),
};
const request = (path: string, init?: RequestInit) =>
  new Request('https://history.example' + path, init);
test('all endpoints reject missing trusted identity before accessing storage', async () => {
  for (const path of [
    '/api/search?q=test',
    '/api/fetch?id=abc',
    '/api/status',
    '/api/ingest',
    '/api/thread?id=abc',
  ]) {
    const response = await handleAPI(request(path), null, history);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
});
test('search always uses authenticated owner, ignoring attacker owner parameter', async () => {
  const response = await handleAPI(
    request('/api/search?q=passage&owner=victim'),
    'reader',
    history,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1), ['reader', 'passage']);
});
test('errors never expose stored values or internal exception messages', async () => {
  const response = await handleAPI(
    request('/api/fetch?id=missing'),
    'reader',
    history,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes('private'), false);
  const unexpected = await safeResponse(async () => {
    throw new Error('secret');
  });
  assert.equal(unexpected.status, 503);
  assert.equal((await unexpected.text()).includes('secret'), false);
});
test('mutations reject cross-origin and non-JSON requests', async () => {
  for (const headers of [
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/json', origin: 'https://attacker.example' },
  ] as Record<string, string>[]) {
    const response = await handleAPI(
      request('/api/ingest', { method: 'POST', headers, body: '{}' }),
      'reader',
      history,
    );
    assert.ok([403, 415].includes(response.status));
  }
  const response = await handleAPI(
    request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"owner":"victim"}',
    }),
    'reader',
    history,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1), ['reader', { owner: 'victim' }]);
});
test('bounded reader rejects chunked oversize, bad JSON and false content-length', async () => {
  await assert.rejects(
    readJSON(request('/', { method: 'POST', body: 'x'.repeat(524289) })),
    { status: 413 },
  );
  await assert.rejects(
    readJSON(
      request('/', {
        method: 'POST',
        headers: { 'content-length': '1' },
        body: 'x'.repeat(524289),
      }),
    ),
    { status: 413 },
  );
  await assert.rejects(readJSON(request('/', { method: 'POST', body: '{' })), {
    status: 400,
  });
});
test('owner deletion uses explicit DELETE and same-origin guard', async () => {
  const denied = await handleAPI(
    request('/api/thread?id=thread', {
      method: 'DELETE',
      headers: { origin: 'https://attacker.example' },
    }),
    'reader',
    history,
  );
  assert.equal(denied.status, 403);
  const allowed = await handleAPI(
    request('/api/thread?id=thread', { method: 'DELETE' }),
    'reader',
    history,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls.at(-1), ['reader', 'thread']);
});
