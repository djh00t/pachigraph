import Link from 'next/link';
import { getHistory } from '../db';
import { requireChatGPTUser, chatGPTSignOutPath } from './chatgpt-auth';

export const dynamic = 'force-dynamic';
type Params = { q?: string; id?: string };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  return <HistoryPage params={await searchParams} />;
}
async function HistoryPage({ params }: { params: Params }) {
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 256) : '';
  const id = typeof params.id === 'string' ? params.id : '';
  const user = await requireChatGPTUser('/?' + new URLSearchParams({ q, id }));
  const history = getHistory();
  const status = await history.status(user.userId);
  const results = q ? (await history.search(user.userId, q)).results : [];
  let selected: Awaited<ReturnType<typeof history.fetch>> | null = null;
  let fetchError = false;
  if (id) {
    try {
      selected = await history.fetch(user.userId, id);
    } catch {
      fetchError = true;
    }
  }
  return (
    <main>
      <header>
        <Link className="wordmark" href="/">
          Pachigraph <span>PRIVATE ARCHIVE</span>
        </Link>
        <a className="muted" href={chatGPTSignOutPath()} target="_top">
          Sign out
        </a>
      </header>
      <section className="intro">
        <p className="eyebrow">THE ELEPHANT THAT NEVER FORGETS</p>
        <h1>
          Find the thought.
          <br />
          <span>Keep the evidence.</span>
        </h1>
        <p>
          Search your active and archived Codex conversations. Every result
          leads back to its source.
        </p>
        <search>
          <form method="get">
            <label className="sr-only" htmlFor="query">
              Search history
            </label>
            <input
              id="query"
              name="q"
              defaultValue={q}
              maxLength={256}
              placeholder="A decision, an error, a useful command…"
              required
            />
            <button type="submit">
              Search <span aria-hidden="true">↗</span>
            </button>
          </form>
        </search>
      </section>
      <aside className="status" aria-label="Ingestion status">
        <div>
          <strong>{status.threads.toLocaleString()}</strong>
          <span>conversations</span>
        </div>
        <div>
          <strong>{status.records.toLocaleString()}</strong>
          <span>source revisions</span>
        </div>
        <div>
          <strong>{(status.text_bytes / 1024 / 1024).toFixed(2)} MB</strong>
          <span>indexed text</span>
        </div>
        <div>
          <strong>
            {status.last_ingested_at
              ? new Date(status.last_ingested_at)
                  .toISOString()
                  .slice(0, 16)
                  .replace('T', ' ') + ' UTC'
              : 'Awaiting import'}
          </strong>
          <span>last ingestion</span>
        </div>
      </aside>
      <section className="workspace">
        <div>
          <div className="section-label">
            <h2>{q ? 'Search results' : 'Your archive'}</h2>
            <span>
              {q
                ? `${results.length} matches · up to 20`
                : 'Source records, preserved'}
            </span>
          </div>
          {results.map((result) => (
            <article
              className={'result ' + (id === result.id ? 'selected' : '')}
              key={result.id}
            >
              <p className="eyebrow">
                {result.timestamp} · {result.thread_id.slice(0, 8)}
              </p>
              <Link
                prefetch={false}
                href={'/?' + new URLSearchParams({ q, id: result.id })}
              >
                <p>{result.text}</p>
                <span className="result-link">Read source record →</span>
              </Link>
            </article>
          ))}
          {results.length === 0 && (
            <div className="empty">
              <div className="archive-symbol" aria-hidden="true">
                ⌕
              </div>
              <h3>
                {q
                  ? 'No matching passages'
                  : status.records
                    ? 'What would you like to remember?'
                    : 'Your history starts here'}
              </h3>
              <p>
                {q
                  ? 'Try a distinctive word or a shorter phrase.'
                  : status.records
                    ? 'Search for a phrase, decision, error, or command.'
                    : 'After the first import, your conversations will be searchable here.'}
              </p>
            </div>
          )}
        </div>
        <aside className="source">
          <h2>Source evidence</h2>
          {selected ? (
            <>
              <p className="eyebrow">{selected.timestamp}</p>
              <p className="source-text">{selected.text}</p>
              <dl>
                <dt>Original conversation</dt>
                <dd>
                  <a href={'codex://threads/' + selected.thread_id}>
                    {selected.thread_id}
                  </a>
                </dd>
                <dt>Citation</dt>
                <dd>{selected.citation}</dd>
              </dl>
              <p className="muted">
                Opening the original requires Codex on this device. Earlier
                revisions can appear separately.
              </p>
              <details>
                <summary>Sanitized source record</summary>
                <pre>{JSON.stringify(selected.record, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p className="muted">
              {fetchError
                ? 'This source is unavailable or has been deleted.'
                : 'Select a result to inspect the preserved passage and its citation.'}
            </p>
          )}
        </aside>
      </section>
      <footer>
        <span>
          Historical evidence. Your agent supplies the interpretation.
        </span>
        <span>{user.displayName}</span>
      </footer>
    </main>
  );
}
