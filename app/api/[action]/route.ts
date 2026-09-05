import { getChatGPTUser } from '../../chatgpt-auth';
import { getHistory, getKeys } from '../../../db';
import { handleAPI, safeResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  const owner = user?.userId ?? null;
  if (new URL(request.url).pathname === '/api/keys')
    return getKeys().manage(request, owner);
  return safeResponse(async () =>
    handleAPI(request, await getKeys().resolve(request, owner), getHistory()),
  );
}
export { handle as GET, handle as POST, handle as DELETE };
