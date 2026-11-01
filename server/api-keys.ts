import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { boundTenant, type Principal } from './auth.ts';
import { checkOrigin, fail, readJSON, safeResponse } from './http.ts';

function hash(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

function allows(scope: 'read' | 'ingest', path: string, method: string) {
  if (path === '/api/whoami' && method === 'GET') return true;
  if (scope === 'read') {
    return (
      (method === 'GET' &&
        ['/api/search', '/api/fetch', '/api/status'].includes(path)) ||
      (path === '/mcp' && method === 'POST')
    );
  }
  return scope === 'ingest' && path === '/api/ingest' && method === 'POST';
}

export function createKeys(pool: Pool) {
  return {
    async resolve(request: Request): Promise<Principal | null> {
      const authorization = request.headers.get('authorization');
      if (authorization === null) return null;
      if (!/^Bearer pg_[a-f0-9]{64}$/.test(authorization)) fail(401);
      const result = await pool.query<{
        tenant_id: string;
        owner_id: string;
        scope: string;
        expires_at: string;
      }>(
        `SELECT tenant_id, owner_id, scope, expires_at
         FROM pachigraph.api_keys
         WHERE digest = $1 AND expires_at > $2`,
        [hash(authorization.slice(7)), Date.now()],
      );
      const row = result.rows[0];
      if (!row) fail(401);
      const tenant = await boundTenant(pool, row.owner_id, row.tenant_id);
      if (!tenant) fail(401);
      const path = new URL(request.url).pathname;
      if (path === '/api/keys') fail(401);
      if (row.scope !== 'read' && row.scope !== 'ingest') fail(403);
      if (!allows(row.scope, path, request.method)) fail(403);
      return {
        tenant,
        subject: row.owner_id,
        scope: row.scope,
        expiresAt: new Date(Number(row.expires_at)),
      };
    },

    manage(request: Request, principal: Principal | null) {
      return safeResponse(async () => {
        if (
          !principal ||
          principal.scope !== 'session' ||
          request.headers.get('authorization')?.startsWith('Bearer pg_')
        ) {
          fail(401);
        }
        checkOrigin(request);
        const tenant = principal.tenant;
        const subject = principal.subject;
        if (request.method === 'GET') {
          const result = await pool.query<{
            id: string;
            scope: string;
            expires_at: string;
          }>(
            `SELECT id, scope, expires_at FROM pachigraph.api_keys
             WHERE tenant_id = $1 AND owner_id = $2
             ORDER BY expires_at DESC`,
            [tenant, subject],
          );
          return result.rows.map((row) => ({
            ...row,
            expires_at: Number(row.expires_at),
          }));
        }
        if (request.method === 'DELETE') {
          await pool.query(
            `DELETE FROM pachigraph.api_keys
             WHERE tenant_id = $1 AND owner_id = $2 AND id::text = $3`,
            [
              tenant,
              subject,
              new URL(request.url).searchParams.get('id') ?? '',
            ],
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
             (id, owner_id, tenant_id, digest, scope, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, subject, tenant, hash(key), input.scope, expires_at],
        );
        return { id, key, scope: input.scope, expires_at };
      });
    },
  };
}
