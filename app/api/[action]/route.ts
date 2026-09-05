import { getChatGPTUser } from '../../chatgpt-auth';
import { getHistory } from '../../../db';
import { handleAPI } from '../../../server/http';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  return handleAPI(request, user?.userId ?? null, getHistory());
}
export { handle as GET, handle as POST, handle as DELETE };
