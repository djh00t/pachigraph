import { getHistory, getKeys, getPool } from '../../db';
import { dispatchMCP } from '../../server/dispatch.ts';
import { safeResponse } from '../../server/http.ts';
import { getUser } from '../auth';

export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  return safeResponse(async () => {
    const user = await getUser(request.headers);
    return dispatchMCP(request, user, getKeys(), getHistory(), getPool());
  });
}

export { handle as GET, handle as POST, handle as DELETE };
