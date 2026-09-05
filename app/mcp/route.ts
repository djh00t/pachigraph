import { getChatGPTUser } from '../chatgpt-auth';
import { getHistory } from '../../db';
import { handleMCP } from '../../server/mcp';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  return handleMCP(request, user?.userId ?? null, getHistory());
}
export { handle as GET, handle as POST, handle as DELETE };
