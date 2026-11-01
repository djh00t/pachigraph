# Tenancy

Pachigraph stores each archive in one tenant. A tenant id is random, shaped
`t-` plus 16 lowercase hex characters (`^t-[0-9a-f]{16}$`). It is not derived
from a person, an email, or a subject. Holders of a read key can see their own
tenant id through `GET /api/whoami`, so an id must not identify anyone.

The server owns the binding. A tenant value in a request body, query, or header
is ignored. An SSO subject is bound to exactly one tenant. `tenant_members`
joined to `tenants.active` is the only gate for browser sessions and API keys,
on every request. `PACHIGRAPH_ALLOWED_SUBJECTS` is only an OIDC pre-filter for
sign-in. Removing a subject from that list blocks new sign-in. It does not
disable a subject that is still bound.

## Deploying migration 0002

There is no pre-bind step. Migration `0002_tenancy.sql` runs by itself when the
server starts, inside the startup transaction. It gives each existing owner its
own new tenant. It does not merge owners.

Before deploying 0002, record how large the database is where database access
already lives: the size of each table and index in schema `pachigraph`, and
the number of rows in `history_records`. Expect a startup delay proportional
to that size. The migration takes an exclusive lock while it rewrites
`history_records`.

Default quotas, stored as constants in the migration, are 1,000,000 records and
10 GiB (10737418240 bytes). If a backfilled tenant is already over those caps,
ingest is refused and reads keep working. Change a cap with `quota` before
reopening traffic when the recorded counts require it.

After the new process is up, keep user traffic closed. Bind any allowlisted
subject that had no rows yet. Then reopen traffic. Until `bind`, that subject
gets 401. Nothing already stored is lost.

## Release note

A browser session can no longer ingest. `POST /api/ingest` from a session
returns 403 `Scope not allowed`. Only an ingest key can write. Reads, thread
delete, and `GET /api/whoami` still work for a bound session.

## Removing a person

`unbind` removes a person. In the same transaction it deletes every API key
that person created, so binding them again does not bring those keys back.
Their sessions stop at once. Deactivating the tenant does the same for
everyone bound to it. Tenant ids are never renamed.

Moving or merging data between tenants is an export and a re-import. `rebind`
moves a subject to a different existing tenant. It does not move rows, and it
does not rename a tenant. In that same transaction it deletes the subject's
keys on the tenant they are leaving, so rebinding away and back does not
bring those keys back. `unbind` deletes their keys as well.

## Thread delete

A thread delete is permanent in v1. The tombstone blocks every later import of
that thread into that tenant only (410). There is no untombstone. Do not delete
a thread to refresh it or to drop older revisions.

The server stores redaction fingerprints inside the record (`rule`, `path`,
`fp`). It has no quarantine API and stores no secret.

## Operator CLI

Run `node scripts/tenant.ts <command>` where `DATABASE_URL` is already set.
`create` generates the id itself and takes no id argument. A supplied id, an
email, or a subject is refused.

```text
node scripts/tenant.ts create
node scripts/tenant.ts list [--subjects]
node scripts/tenant.ts quota <tenant> <max_records> <max_bytes>
node scripts/tenant.ts deactivate <tenant>
node scripts/tenant.ts bind <subject> <tenant>
node scripts/tenant.ts rebind <subject> <tenant>
node scripts/tenant.ts unbind <subject>
```

`list` prints tenant ids, member counts, usage, and quotas. It prints subjects
only with `--subjects`. `bind` attaches a subject to an existing tenant. A
second `bind` is refused; use `rebind`. `quota` sets `max_records` and
`max_bytes`. `deactivate` sets `active` to false.
