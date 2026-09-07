import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { checkOrigin, fail, readJSON, safeResponse } from './http.ts';

function hash(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

export function createKeys(pool: Pool) {
  return {
    async resolve(request: Request, browserOwner: string | null) {
      const authorization = request.headers.get('authorization');
      if (authorization === null) return browserOwner;
      if (browserOwner && !authorization.startsWith('Bearer pg_'))
        return browserOwner;
      if (!/^Bearer pg_[a-f0-9]{64}$/.test(authorization)) fail(401);
      const result = await pool.query<{ owner_id: string; scope: string }>(
        `SELECT owner_id, scope FROM pachigraph.api_keys
         WHERE digest = $1 AND expires_at > $2`,
        [hash(authorization.slice(7)), Date.now()],
      );
      const row = result.rows[0];
      if (!row) fail(401);
      const path = new URL(request.url).pathname;
      const allowed =
        row.scope === 'read'
          ? (['/api/search', '/api/fetch', '/api/status'].includes(path) &&
              request.method === 'GET') ||
            (path === '/mcp' && request.method === 'POST')
          : row.scope === 'ingest' &&
            path === '/api/ingest' &&
            request.method === 'POST';
      if (!allowed) fail(403);
      return row.owner_id;
    },

    manage(request: Request, owner: string | null) {
      return safeResponse(async () => {
        if (
          !owner ||
          request.headers.get('authorization')?.startsWith('Bearer pg_')
        ) {
          fail(401);
        }
        checkOrigin(request);
        if (request.method === 'GET') {
          const result = await pool.query<{
            id: string;
            scope: string;
            expires_at: string;
          }>(
            `SELECT id, scope, expires_at FROM pachigraph.api_keys
             WHERE owner_id = $1 ORDER BY expires_at DESC`,
            [owner],
          );
          return result.rows.map((row) => ({
            ...row,
            expires_at: Number(row.expires_at),
          }));
        }
        if (request.method === 'DELETE') {
          await pool.query(
            'DELETE FROM pachigraph.api_keys WHERE owner_id = $1 AND id::text = $2',
            [owner, new URL(request.url).searchParams.get('id') ?? ''],
          );
          return { revoked: true };
        }
        if (request.method !== 'POST') fail(405);
        if (
          request.headers.get('content-type')?.split(';')[0] !==
          'application/json'
        ) {
          fail(415);
        }
        const input = (await readJSON(request)) as {
          scope?: string;
          days?: number;
        } | null;
        if (
          !input ||
          !['read', 'ingest'].includes(input.scope ?? '') ||
          !Number.isInteger(input.days) ||
          input.days! < 1 ||
          input.days! > 365
        ) {
          fail(400);
        }
        const key = `pg_${randomBytes(32).toString('hex')}`;
        const id = randomUUID();
        const expires_at = Date.now() + input.days! * 86400000;
        await pool.query(
          `INSERT INTO pachigraph.api_keys
             (id, owner_id, digest, scope, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, owner, hash(key), input.scope, expires_at],
        );
        return { id, key, scope: input.scope, expires_at };
      });
    },
  };
}
