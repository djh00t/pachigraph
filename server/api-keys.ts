import { checkOrigin, fail, readJSON, safeResponse } from './http.ts';

export function createKeys(db: D1Database) {
  async function hash(key: string) {
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(key),
    );
    return Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  return {
    async resolve(request: Request, browserOwner: string | null) {
      const authorization = request.headers.get('authorization');
      if (authorization === null) return browserOwner;
      if (!/^Bearer pg_[a-f0-9]{64}$/.test(authorization)) fail(401);
      const row = await db
        .prepare(
          'SELECT owner_id, scope FROM api_keys WHERE digest = ? AND expires_at > ?',
        )
        .bind(await hash(authorization.slice(7)), Date.now())
        .first<{ owner_id: string; scope: string }>();
      if (!row) fail(401);
      const path = new URL(request.url).pathname;
      const allowed =
        row.scope === 'read'
          ? ['/api/search', '/api/fetch', '/api/status'].includes(path) &&
            request.method === 'GET'
          : row.scope === 'ingest' &&
            path === '/api/ingest' &&
            request.method === 'POST';
      if (!allowed) fail(403);
      return row.owner_id;
    },
    manage(request: Request, owner: string | null) {
      return safeResponse(async () => {
        if (!owner || request.headers.has('authorization')) fail(401);
        checkOrigin(request);
        if (request.method === 'GET') {
          return (
            await db
              .prepare(
                'SELECT id, scope, expires_at FROM api_keys WHERE owner_id = ? ORDER BY expires_at DESC',
              )
              .bind(owner)
              .all()
          ).results;
        }
        if (request.method === 'DELETE') {
          await db
            .prepare('DELETE FROM api_keys WHERE owner_id = ? AND id = ?')
            .bind(owner, new URL(request.url).searchParams.get('id') ?? '')
            .run();
          return { revoked: true };
        }
        if (request.method !== 'POST') fail(405);
        if (
          request.headers.get('content-type')?.split(';')[0] !==
          'application/json'
        )
          fail(415);
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
        )
          fail(400);
        const key =
          'pg_' +
          Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
            b.toString(16).padStart(2, '0'),
          ).join('');
        const id = crypto.randomUUID();
        const expires_at = Date.now() + input.days! * 86400000;
        await db
          .prepare(
            'INSERT INTO api_keys (id, owner_id, digest, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(id, owner, await hash(key), input.scope, expires_at)
          .run();
        return { id, key, scope: input.scope, expires_at };
      });
    },
  };
}
