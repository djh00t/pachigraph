import { getUser } from '../../auth';
import { getHistory, getKeys, getPool } from '../../../db';
import { dispatchAPI } from '../../../server/dispatch.ts';
import { safeResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  return safeResponse(async () => {
    const user = await getUser(request.headers);
    return dispatchAPI(request, user, getKeys(), getHistory(), getPool());
  });
}
export { handle as GET, handle as POST, handle as DELETE };
