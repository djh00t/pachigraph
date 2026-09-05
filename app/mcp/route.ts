import { getChatGPTUser } from '../chatgpt-auth';
import { getHistory, getKeys } from '../../db';
import { safeResponse } from '../../server/http';
import { handleMCP } from '../../server/mcp';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  return safeResponse(async () =>
    handleMCP(
      request,
      await getKeys().resolve(request, user?.userId ?? null),
      getHistory(),
    ),
  );
}
export { handle as GET, handle as POST, handle as DELETE };
