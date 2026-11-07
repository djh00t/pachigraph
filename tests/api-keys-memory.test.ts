import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createKeys } from '../server/api-keys.ts';

test('read keys may call as-of lookup but cannot ingest', async () => {
  const pool = {
    query: async () => ({ rows: [{ owner_id: 'reader', scope: 'read' }] }),
  };
  const keys = createKeys(pool as unknown as Pool);
  const token = `Bearer pg_${'a'.repeat(64)}`;
  const asOfRequest = new Request(
    'https://site.test/api/as-of?root_id=record&valid_at=2031-01-01T00%3A00%3A00Z&recorded_at=2031-02-01T00%3A00%3A00Z',
    { headers: { authorization: token } },
  );
  assert.equal(await keys.resolve(asOfRequest, null), 'reader');
  await assert.rejects(
    keys.resolve(
      new Request('https://site.test/api/ingest', {
        method: 'POST',
        headers: { authorization: token },
      }),
      null,
    ),
    { status: 403 },
  );
});
