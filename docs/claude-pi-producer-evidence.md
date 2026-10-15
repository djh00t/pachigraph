# Claude and Pi fixture evidence

Issue: [Pachigraph #9](https://github.com/djh00t/pachigraph/issues/9).
All fixture text, identifiers, paths and times are synthetic. No personal logs were
read. These are producer-shaped source review cases, not a new API schema.

## Pinned primary sources

- Claude: `@anthropic-ai/claude-agent-sdk@0.2.80`, registry `gitHead`
  `4a3c4af19347d953001d6f4165a0aade4db22818`.
  [Published declaration](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.2.80/sdk.d.ts),
  lines 464-485 and 2427-2437; [registry metadata](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.2.80).
  The historical `SessionMessage` exposes type, uuid, session_id, message and
  parent_tool_use_id; it has no timestamp. The reader documents parentUuid chain
  reconstruction, user/assistant selection and pagination. This does not establish
  full transcript coverage. Raw transcript timestamps may exist but this reader
  does not expose them. Do not infer them from capture time or session metadata.
- Pi: upstream `earendil-works/pi` (formerly `badlogic/pi-mono`), commit
  `4954d760504c11df9b2cbdc040346107b6a8153d`, package
  `@earendil-works/pi-coding-agent@1.3.0`, session format version 3.
  [Session manager](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/coding-agent/src/core/session-manager.ts)
  defines string session IDs, constrained custom IDs, 8-hex entry IDs with UUID
  collision fallback, and v1 migration generating missing IDs/parent links.
  `appendMessage` stamps append time separately from nested message time.
  [Format documentation](https://github.com/earendil-works/pi/blob/4954d760504c11df9b2cbdc040346107b6a8153d/packages/coding-agent/docs/session-format.md)
  distinguishes ISO entry timestamps from epoch-millisecond message timestamps.

Reviewed public sources on 2026-10-16 UTC. The Claude fixture intentionally pins a
historical reader version; it does not claim the latest SDK has identical fields.
The Pi fixture uses the verified current source revision, not an assumed old name.

## Bounded deliverable and dependencies

| Task | Dependency | Deliverable | Evidence / next check |
| --- | --- | --- | --- |
| Producer source review | Public source access only | Pins above | Published Claude declarations and Pi implementation |
| Synthetic fixture pair | Source review | `tests/fixtures/cross-platform/claude-pi.json` | JSON parse and semantic assertions |
| Future adapter/contract tests | Reviewed archive contract | Separate follow-up | Must preserve optional source IDs/times and unknown coverage |
| Shared integration review | Future implementation | Separate review wait | No deployment or personal import implied |

The Pi cases include duplicate text with distinct IDs and a legacy row without an
ID. Migration-generated producer IDs must not be assumed stable across fresh reads
of unchanged legacy input: retain generated archive identities and a replay
checkpoint. Preserve opaque upstream identifiers separately. A selected chain or
file excerpt leaves full archive coverage unknown. Keep capture time separate from
original time; retain both Pi times without silently choosing one meaning.

These fixtures do not prove adapter correctness, sanitization, database migration,
checkpoint persistence or compatibility with existing consumers. They are inputs
for those separately reviewed slices. No producer package was installed or run.
