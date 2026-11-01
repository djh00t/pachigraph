import { z } from 'zod';
import type { Principal, TenantId } from './auth.ts';

/** HTTP boundary for authenticated archive API routes. */
export type HistoryAPI = {
  search(tenant: TenantId, query: string): Promise<unknown>;
  fetch(tenant: TenantId, id: string): Promise<unknown>;
  ingest(tenant: TenantId, input: unknown): Promise<unknown>;
  deleteThread(tenant: TenantId, id: string): Promise<unknown>;
  status(tenant: TenantId): Promise<unknown>;
};

export const WhoamiResponse = z.object({
  tenant: z.string(),
  scope: z.enum(['read', 'ingest', 'session']),
  expires_at: z.string(),
});

const REASONS = ['Origin rejected', 'Scope not allowed'] as const;
type FailReason = (typeof REASONS)[number];

const messages: Record<number, string> = {
  400: 'Invalid request',
  401: 'Sign in required',
  403: 'Origin rejected',
  404: 'Not found',
  405: 'Method not allowed',
  410: 'Thread deleted',
  413: 'Request too large',
  415: 'JSON required',
  507: 'Storage quota exceeded',
  503: 'Temporarily unavailable',
};
export function fail(status: number, reason?: FailReason): never {
  throw Object.assign(new Error(reason ?? messages[status]), { status });
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) fail(403);
}
export async function readJSON(request: Request): Promise<unknown> {
  const limit = 512 * 1024;
  if (Number(request.headers.get('content-length')) > limit) fail(413);
  const reader = request.body?.getReader();
  if (!reader) fail(400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        fail(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(400);
  }
}
export async function safeResponse(
  operation: () => Promise<unknown>,
): Promise<Response> {
  try {
    const result = await operation();
    const response =
      result instanceof Response ? result : Response.json(result);
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-content-type-options', 'nosniff');
    return response;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'status' in error
        ? Number(error.status)
        : 503;
    const status = Object.hasOwn(messages, code) ? code : 503;
    const thrown = error instanceof Error ? error.message : '';
    const message = REASONS.includes(thrown as FailReason)
      ? thrown
      : messages[status];
    return Response.json(
      { error: message },
      { status, headers: { 'cache-control': 'no-store' } },
    );
  }
}
export function handleAPI(
  request: Request,
  principal: Principal | null,
  history: HistoryAPI,
) {
  return safeResponse(async () => {
    if (!principal) fail(401);
    const url = new URL(request.url);
    const tenant = principal.tenant;
    if (request.method === 'GET' && url.pathname === '/api/whoami') {
      return WhoamiResponse.parse({
        tenant: principal.tenant,
        scope: principal.scope,
        expires_at: principal.expiresAt.toISOString(),
      });
    }
    if (request.method === 'GET') {
      if (principal.scope === 'ingest') fail(403, 'Scope not allowed');
      if (url.pathname === '/api/search')
        return history.search(tenant, url.searchParams.get('q') ?? '');
      if (url.pathname === '/api/fetch')
        return history.fetch(tenant, url.searchParams.get('id') ?? '');
      if (url.pathname === '/api/status') return history.status(tenant);
    }
    checkOrigin(request);
    if (request.method === 'POST' && url.pathname === '/api/ingest') {
      if (principal.scope !== 'ingest') fail(403, 'Scope not allowed');
      if (
        request.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      )
        fail(415);
      return history.ingest(tenant, await readJSON(request));
    }
    if (request.method === 'DELETE' && url.pathname === '/api/thread') {
      if (principal.scope !== 'session') fail(403, 'Scope not allowed');
      return history.deleteThread(tenant, url.searchParams.get('id') ?? '');
    }
    fail(405);
  });
}
