import type { TenantId } from '../server/auth.ts';
import { createHistory } from '../server/history.ts';

type Params = { q?: string; id?: string };
type Archive = ReturnType<typeof createHistory>;

export async function loadArchive(
  tenant: TenantId,
  history: Archive,
  params: Params,
) {
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 256) : '';
  const id = typeof params.id === 'string' ? params.id : '';
  const status = await history.status(tenant);
  const results = q ? (await history.search(tenant, q)).results : [];
  let selected: Awaited<ReturnType<Archive['fetch']>> | null = null;
  let fetchError = false;
  if (id) {
    try {
      selected = await history.fetch(tenant, id);
    } catch {
      fetchError = true;
    }
  }
  return { q, id, status, results, selected, fetchError };
}
