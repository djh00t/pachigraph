# Source preparation evaluation

Issue #2, central epic #878/workstream #882. Frozen approved central source `3a9299607128bd633bcd7e39ed25b6dcc78da8a7`.

## Verification

Default make check safely refused database-backed tests before connection because no designated synthetic PostgreSQL fixture was configured. Source-scoped make check used a temporary root Makefile copy changing only Node test selection: tsc/lint and 4 new Node tests passed; 39 collector and 6 plugin Python tests passed. npm build passed. Existing hosted CI supplies PostgreSQL 17 and must complete the full suite. No local database or memory API mutation was attempted. Existing fsevents script warning and 13 audit findings (3 critical/8 high/2 moderate) were observed on the unchanged lockfile and tracked separately; no security qualification or dependency fix is claimed. Review found incorrect home-CIDR and no-image-publication wording, both corrected before delivery; browser policy has OIDC/no gateway CIDR block, API uses app bearer+allowed subjects, and existing codex/main CI may publish a candidate without updating the pinned deployment digest.

Full central-owner render equality passed for every selected workload and route/policy object, including all selectors, ports, mounts, namespace, image, references, activation flags and access policy. One-time verifier diagnostics contain identities only; no Secret bodies parsed/decrypted or provider/cluster calls made. Permanent tests use current local source with no historical/external checkout or kubectl requirement. No tracked workflow, dependency, application code or release-lock contract changes.

Independent adversarial review completed; exact-head hosted CI is recorded on issue/PR after publication. Main source approval is pending. Source preparation does not establish private Git access, installed Flux path building/permissions, binding isolation, current live UIDs, pruning protection, data restore, runtime/two-interval/30-minute qualification, reverse handoff or operator acceptance. No live adoption, credential/provisioning operation or service upgrade occurred. Full wave 4/cluster completion remains unproven.

Rollback removes these source artifacts only; separately approved live rollback requires protected single-owner reverse transfer. Existing release behavior remains authoritative until accepted cutover.
