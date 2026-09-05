'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Key = { id: string; scope: string; expires_at: number };
export default function KeysPage() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch('/api/keys');
    if (!response.ok) throw new Error('Sign in to manage API keys.');
    setKeys(await response.json());
  }
  useEffect(() => {
    fetch('/api/keys')
      .then(async (response) => {
        if (!response.ok) throw new Error();
        setKeys(await response.json());
      })
      .catch(() => setError('Sign in to manage API keys.'));
  }, []);
  return (
    <main>
      <Link href="/">Back to Pachigraph</Link>
      <h1>API keys</h1>
      <p>
        Each key accesses only your archive. Copy new keys now; they cannot be
        shown again.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setSecret('');
          setError('');
          const form = new FormData(event.currentTarget);
          try {
            const response = await fetch('/api/keys', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                scope: form.get('scope'),
                days: Number(form.get('days')),
              }),
            });
            if (!response.ok) throw new Error();
            setSecret(((await response.json()) as { key: string }).key);
            await refresh();
          } catch {
            setError('Could not create or refresh keys.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Access{' '}
          <select name="scope">
            <option value="read">Search and fetch</option>
            <option value="ingest">Ingest</option>
          </select>
        </label>
        <label>
          Expires in days{' '}
          <input
            name="days"
            type="number"
            min="1"
            max="365"
            defaultValue="30"
            required
          />
        </label>
        <button disabled={busy}>Generate key</button>
      </form>
      {secret && (
        <section>
          <label>
            New key <textarea readOnly value={secret} />
          </label>
          <button onClick={() => setSecret('')}>Hide key</button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <ul>
        {keys.map((key) => (
          <li key={key.id}>
            {key.scope} · expires {new Date(key.expires_at).toISOString()}{' '}
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const response = await fetch(
                    '/api/keys?id=' + encodeURIComponent(key.id),
                    { method: 'DELETE' },
                  );
                  if (!response.ok) throw new Error();
                  setSecret('');
                  await refresh();
                } catch {
                  setError('Could not revoke or refresh keys.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
