import { getUser } from '../../auth';
import { getHistory, getKeys } from '../../../db';
import { handleAPI, safeResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  return safeResponse(async () => {
    const user = await getUser(request.headers);
    const keys = getKeys();
    if (new URL(request.url).pathname === '/api/keys') {
      return keys.manage(request, user?.userId ?? null);
    }
    const owner = user?.userId ?? (await keys.resolve(request, null));
    return handleAPI(request, owner, getHistory());
  });
}
export { handle as GET, handle as POST, handle as DELETE };
