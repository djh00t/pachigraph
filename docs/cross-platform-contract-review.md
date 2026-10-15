# Issue 9: source contract review

Status: proposal for interface review; no production behavior changed.
Baseline: `d28c67beb2d5c96c2bb7a7874cbb77b52ba78187`.
Tracking: <https://github.com/djh00t/pachigraph/issues/9>.

Pachigraph retains durable sanitized raw chats and calls. Agent Brain retains
derived decisions/specifications linked to immutable Pachigraph evidence. This
source preparation does not authorize personal imports or runtime activation.

## Existing behavior and affected consumers

`server/history.ts` requires UUID `thread_id`, SHA-256-shaped event `id`, a
timezone-qualified source `timestamp`, `text`, and JSON `record`. PostgreSQL
`0001_initial.sql` makes source time non-null. Existing archive IDs include owner,
thread, event and revision; revisions hash canonical record, text and timestamp.
Changed records append immutable revisions. Archive receipt time already exists as
`ingested_at`, but search/fetch do not expose it. This is archive capture time,
not the time an offline adapter first captured a producer event; the latter
remains unknown unless separately evidenced. Citations always claim Codex.

`collector/collector.py` already persists checkpoints and fallback occurrence
counters transactionally after acknowledged uploads. Reuse that approach rather
than inventing a universal ingestion framework. Its missing-time gap behavior
must remain unchanged for existing Codex operation until an adapter is qualified.
Preserve recursive sanitization, immutable object writes, owner isolation,
tombstones, payload limits and fail-closed scanning.

Affected surfaces: history validation/storage/revision construction; a new SQL
migration; `app/page.tsx`; HTTP/MCP search and fetch outputs; plugin consumers;
collector checkpoint identity; history, HTTP, MCP and collector compatibility tests.
No source-specific SDK or new permanent raw store is needed.

## Recommended minimal extension (requires review)

Keep existing archive transport identity formats. Treat UUID thread IDs and
SHA-shaped event IDs as archive identities, not requirements on native producers.
For new adapters, allocate and persist a random conversation UUID and random
event token (32 random bytes encoded as 64 lowercase hex characters) before first upload. Persist mapping by source occurrence/position
and checkpoint; retry uses the same token. Never use content hash alone: equal
utterances can be distinct events. Preserve existing Codex identity derivation.
An ID-less legacy source requires a durable occurrence mapping; if it cannot be
reconciled after source rewriting, stop and report a gap instead of merging events.

| Field | Requirement | Reason |
| --- | --- | --- |
| `thread_id`, event `id` | Existing required formats | Stable archive identity and existing client compatibility |
| `text`, `record` | Required, existing bounds and sanitation | Searchable text and immutable sanitized evidence |
| `timestamp` | Required key; string or explicit null | Unknown original time must not be fabricated |
| `ingested_at` output | Server-assigned, separate from source time | Archive receipt time, not claimed speech time |
| `source` | Optional bounded metadata on new records | Native provenance without universal producer requirements |

Proposed `source` object has only optional `platform`, `conversation_id`,
`event_id`, `coverage`, and `corrects` fields. Review proposed limits: platform
64 UTF-8 bytes, opaque IDs 1024 bytes each, total canonical metadata 8 KiB;
reject unknown keys. `coverage` is `partial`, `unknown`, or `complete`, defaults
to unknown, and complete requires producer-specific evidence. `corrects` names
an immutable archive record ID, not mutable upstream text. To obtain it
unambiguously, propose an additive ingest acknowledgement `records` array in input
order containing each transport event `id`, `revision_id`, and `archive_id`, on
both first ingest and duplicate replay. Keep `stored` and `duplicate` unchanged.
Review this response extension explicitly; search by repeated text is not a safe
identity lookup. Persist returned archive IDs before emitting correction links. Do not require speaker,
model, citation, source URI, call duration or original timestamps. Avoid arbitrary
source URLs until their safety and consumer behavior are separately reviewed.

New metadata must pass the existing sanitization policy, including opaque IDs,
before upload; reject or redact secrets without bypassing scanner failure handling.
New metadata must round-trip immutably and participate in revision integrity.
For absent metadata preserve the exact old revision preimage and IDs; introducing
an empty object must not silently churn old identifiers. Store metadata in a
separate bounded database column or immutable envelope only after reviewing how
existing raw `record` readback remains unchanged. This storage decision is open
for review, not assumed implemented.

Use archive `id` and existing owner-scoped `/api/fetch?id=...` retrieval as the
canonical reference for Agent Brain. UI `/?id=...` remains a useful human link.
An absent `source` key is the legacy Codex discriminator; new adapters must
include `source` (an empty object means unknown provenance). Legacy Codex
citations remain byte-compatible; all records with `source` present lead with
archive evidence and never fabricate a Codex deep link. Nullable source time
must render as unknown; sorting should explicitly place nulls last, using capture
time and immutable ID for stable ties. A later correction is a new event linked
to earlier evidence; it does not overwrite speech or imply automatic agreement
resolution. Existing same-event revision behavior remains supported.

Alternative: relaxing archive IDs to arbitrary strings increases validation,
storage-key and deletion scope unnecessarily. Alternative: versioning the entire
ingest endpoint adds migration work before any demonstrated need. Prefer the
small additive proposal above, with explicit compatibility checks.

## Dependency graph and bounded deliverables

Each row is a separately reviewable slice of at most 15 minutes. If implementation
cannot fit, split the row before editing further. Test/review waits are separate.

| Task | Depends on | Deliverable | Completion evidence |
| --- | --- | --- | --- |
| P0 source/ownership inspection | none | Baseline and competing-work check | Main d28c67be; issue 9 unassigned, no comments; only open PR 8 dependency update |
| P1 Codex/partial voice evidence | P0 | Synthetic fixture pair and pinned source evidence | Companion fixture/evidence files; never live qualification |
| P2 Claude/Pi evidence | P0 | Synthetic fixture pair and pinned source evidence | Companion fixture/evidence files; never live qualification |
| P3 contract review | P0, P1, P2 | This proposal with required/optional rationale | Human interface review pending |
| I1 retained identity helper | P3 approved | Durable generated IDs and replay/checkpoint tests | Crash-before/after-ack and repeated equal-content events |
| I2 nullable source time | P3 approved | Additive SQL migration and validation | Existing migration checksum unchanged; null accepted, malformed string rejected |
| I3 metadata persistence | P3 approved | Bounded validation and immutable round-trip | Missing IDs, size boundaries, unknown keys, secret-in-metadata rejection/redaction and owner isolation |
| I4 revision compatibility | I3 | Exact legacy preimage retained | Known legacy IDs/revisions and metadata revision tests |
| I5 nullable readback | I2 | Search/fetch/UI null handling, capture output | Missing time remains null; stable sorting; existing consumers |
| I6a archive identity acknowledgement | I4 | Additive ingest ID mapping, persisted on replay | Existing count-only consumers still work; duplicate returns identical archive IDs |
| I6 archive citations | I3, I5, I6a | Archive-first helper and Agent Brain reference example | Fetch immutable evidence by returned ID; no invented deep link |
| I7 fixture adapters | I1, I2, I3, I4 | Small producer-specific fixture conversions | Each producer ingests, retries, searches and fetches |
| I8 correction/replay regression | I6, I7 | Original plus later correction replay | Two events survive; correction links original; unknown coverage retained |
| V1 shared verification | I1-I8 | Repository local checks/build | Actual output and environment recorded |
| R1 adversarial review | V1 | Independent findings on final diff | Review report and resolved findings |
| R2 Codex review | V1 | Independent Codex review | Review report and resolved findings |
| H1 feature PR | R1, R2 | Non-draft PR, no Actions execution | Head/PR/run inspection; human merge only |

P0-P3 are independent of Flux migration epic 878. No central infrastructure paths
are owned by this work. This checkout owns only issue-9 preparation files; the
fixture agents have separate exact file ownership. No duplicate issue was opened.

## Verification and publication constraints

Repository `make check` requires an explicitly named disposable PostgreSQL test
database, dependencies and Gitleaks; do not point tests at an existing database.
The feature branch must not match `codex/**`: `image.yml` publishes on such pushes.
`check.yml` also runs for every PR. GitHub documents `[skip ci]` in the PR HEAD commit as skipping `pull_request`
and `push` workflows: <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs>.
Use that marker for this preparation branch and verify zero workflow runs after
push and PR creation. Skipped required checks can remain pending; do not treat
that as merge readiness. Do not disable repository Actions or change runtime/access settings.

Acceptance remains pending until ingest/retry/search/readback and correction tests
run against the reviewed contract. Synthetic fixture parsing alone proves neither
live producer capture nor full-call coverage.
