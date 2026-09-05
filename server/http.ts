/** HTTP boundary for authenticated Sites API routes. */
export type HistoryAPI = {
  search(owner: string, query: string): Promise<unknown>;
  fetch(owner: string, id: string): Promise<unknown>;
  ingest(owner: string, input: unknown): Promise<unknown>;
  deleteThread(owner: string, id: string): Promise<unknown>;
  status(owner: string): Promise<unknown>;
};

const messages: Record<number, string> = {
  400: 'Invalid request',
  401: 'Sign in required',
  403: 'Origin rejected',
  404: 'Not found',
  405: 'Method not allowed',
  410: 'Thread deleted',
  413: 'Request too large',
  415: 'JSON required',
  503: 'Temporarily unavailable',
};
export function fail(status: number): never {
  throw Object.assign(new Error(messages[status]), { status });
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
    return Response.json(
      { error: messages[status] },
      { status, headers: { 'cache-control': 'no-store' } },
    );
  }
}
export function handleAPI(
  request: Request,
  owner: string | null,
  history: HistoryAPI,
) {
  return safeResponse(async () => {
    if (!owner) fail(401);
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.pathname === '/api/search')
        return history.search(owner, url.searchParams.get('q') ?? '');
      if (url.pathname === '/api/fetch')
        return history.fetch(owner, url.searchParams.get('id') ?? '');
      if (url.pathname === '/api/status') return history.status(owner);
    }
    checkOrigin(request);
    if (request.method === 'POST' && url.pathname === '/api/ingest') {
      if (
        request.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      )
        fail(415);
      return history.ingest(owner, await readJSON(request));
    }
    if (request.method === 'DELETE' && url.pathname === '/api/thread') {
      return history.deleteThread(owner, url.searchParams.get('id') ?? '');
    }
    fail(405);
  });
}
