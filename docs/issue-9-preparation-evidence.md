# Issue 9 preparation evidence

Scope: documentation and synthetic fixtures/tests only. No contract implementation,
personal imports, runtime, deployment, manifests, access or credential changes.
Current-version Flux migration has no dependency on this proposal.

Branch: `preparation/9-cross-platform-source-review`, based on
`d28c67beb2d5c96c2bb7a7874cbb77b52ba78187`.
Fresh isolated clone: `/Users/djh/Documents/Codex/2026-10-16/task-2/pachigraph`.
No repository or ancestor `AGENTS.md` was found. README, Makefile, collector usage,
feature status, existing migrations, consumers and workflows were reviewed.
Open work inspection found issue 9 unassigned with no comments, PR 8 for
dependencies, and existing source/Flux branches; none of their paths were edited.

## Exact ownership and deliverables

| Owner | Paths | Dependency | Result |
| --- | --- | --- | --- |
| Codex/voice fixture agent | `tests/fixtures/cross-platform/codex-voice.json`, `docs/codex-voice-producer-evidence.md` | Pinned public Codex definitions | Complete; synthetic occurrence/correction assertions passed |
| Claude/Pi fixture agent | `tests/fixtures/cross-platform/claude-pi.json`, `docs/claude-pi-producer-evidence.md` | Pinned Claude SDK/Pi definitions | Complete; synthetic metadata/identity assertions passed |
| App source coordinator | `docs/cross-platform-contract-review.md`, `tests/source-fixtures.test.ts`, this evidence file | Existing consumers and fixture pairs | Proposal and two retained fixture regression tests |
| Migration owner | All infrastructure/runtime paths | Existing accepted migration plan | Separate lane; no ownership acquired here |

First independent fixture evidence: Codex `aff92080f2b8d5f63a63b4ada7b92054287f237c`;
Claude SDK `0.2.80` registry gitHead `4a3c4af19347d953001d6f4165a0aade4db22818`;
Pi `1.3.0`, commit `4954d760504c11df9b2cbdc040346107b6a8153d`.
Source-shaped fixtures deliberately are not ingest envelopes. No adapter or live
capture qualification is implied by their passing tests.

## Independent reviews

Adversarial review: **PASS for preparation only** after clarifying legacy-source
discrimination, compatible generated token encoding, receipt-time semantics,
metadata sanitization and immutable correction-ID acknowledgement mapping.
Reviewer independently ran the two fixture tests successfully.

Independent Codex review: **Ship preparation for interface review**, no remaining
findings after explicit legacy/new citation routing and replay-stable archive-ID
acknowledgements. Reviewer independently ran two fixture tests. Independently
verified Pi definitions; its Claude web fetch was unavailable, so Claude pin
verification comes from the fixture producer's primary-source fetch.

Neither review approves implementation or runtime readiness. Human review of
the proposed contract remains pending; issue 9 acceptance is not complete.

## Local verification

- Locked dependencies installed with `npm ci --ignore-scripts`; lockfile unchanged.
- `npx tsc --noEmit`: passed.
- `npm run lint`: passed.
- `npx oxfmt --check tests/source-fixtures.test.ts`: passed after formatting.
- `node --test tests/source-fixtures.test.ts`: 2 passed.
- `npm run build`: passed.
- Collector suite: 39 passed; plugin suite: 6 passed.
- Full `make check`: passed; 39 Node tests, 39 collector tests and 6 plugin tests (84 total).
- `git diff --check`: passed.

Initial sandbox runs could not bind test loopback sockets. The same synthetic
suites passed with approved local execution. PostgreSQL checks use only an
ephemeral, loopback-bound `postgres:17` container named `pachigraph-issue9-test`,
with a synthetic password and disposable `pachigraph_test_ci` database. Remove
the container after checks; no persistent service configuration is altered.

Publication uses a non-`codex/**` branch and `[skip ci]` commit marker to suppress
Actions; inspect runs after push and PR creation. Human merge only. Existing
dependency advisories are tracked separately in issue 3 and were not modified.
