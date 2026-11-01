import { createElement, Fragment, type ReactNode } from 'react';
import type { TenantId } from '../server/auth.ts';
import { createHistory, isChatGptThread } from '../server/history.ts';

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

function item(label: string, value: ReactNode) {
  return createElement(
    Fragment,
    null,
    createElement('dt', null, label),
    createElement('dd', null, value),
  );
}

export function SourceEvidence({
  threadId,
  citation,
}: {
  threadId: string;
  citation: string;
}) {
  if (isChatGptThread(threadId)) {
    return createElement(
      Fragment,
      null,
      createElement('p', null, 'Imported from a ChatGPT export'),
      createElement('dl', null, item('Citation', citation)),
    );
  }
  return createElement(
    Fragment,
    null,
    createElement(
      'dl',
      null,
      item(
        'Original conversation',
        createElement('a', { href: 'codex://threads/' + threadId }, threadId),
      ),
      item('Citation', citation),
    ),
    createElement(
      'p',
      { className: 'muted' },
      'Opening the original requires Codex on this device. Earlier revisions can appear separately.',
    ),
  );
}
