import { getHistory, getKeys } from '../../db';
import { handleMCP } from '../../server/mcp.ts';
import { safeResponse } from '../../server/http.ts';
import { getUser } from '../auth';

export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  return safeResponse(async () => {
    const user = await getUser(request.headers);
    const owner = user?.userId ?? (await getKeys().resolve(request, null));
    return handleMCP(request, owner, getHistory());
  });
}

export { handle as GET, handle as POST, handle as DELETE };
