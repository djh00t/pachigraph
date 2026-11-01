import type { Pool } from 'pg';
import { sessionPrincipal, type Principal, type VerifiedUser } from './auth.ts';
import { fail, handleAPI, type HistoryAPI } from './http.ts';

type KeyAPI = {
  resolve(request: Request): Promise<Principal | null>;
  manage(request: Request, principal: Principal | null): Promise<Response>;
};

export async function dispatchAPI(
  request: Request,
  user: VerifiedUser | null,
  keys: KeyAPI,
  history: HistoryAPI,
  pool: Pool,
) {
  if (new URL(request.url).pathname === '/api/keys') {
    if (!user) fail(401);
    return keys.manage(request, await sessionPrincipal(pool, user));
  }
  const principal = user
    ? await sessionPrincipal(pool, user)
    : await keys.resolve(request);
  return handleAPI(request, principal, history);
}
