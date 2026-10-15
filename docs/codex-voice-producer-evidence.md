# Codex and partial voice fixture evidence

Issue: [Pachigraph #9](https://github.com/djh00t/pachigraph/issues/9).
This source-preparation slice owns only this document and
`tests/fixtures/cross-platform/codex-voice.json`. It depends on public producer
definitions and the existing collector, not deployment or Flux work. Its
deliverable is synthetic evidence for contract review; it adds no ingestion
adapter and does not define a new wire contract.

## Verified primary source

GitHub's commit API resolved `openai/codex` main to
`aff92080f2b8d5f63a63b4ada7b92054287f237c` during preparation. The files below were
then fetched at that exact commit through the GitHub connector (rather than
relying on the separately indexed main-branch search results).

- [protocol.rs](https://github.com/openai/codex/blob/aff92080f2b8d5f63a63b4ada7b92054287f237c/codex-rs/protocol/src/protocol.rs):
  `UserMessageEvent` has message text and optional `client_id`; it has no required
  native event ID. `RealtimeTranscriptEntry` has role and text only.
  `RealtimeHandoffRequested` contains `handoff_id`, `item_id`, `input_transcript`
  and `active_transcript`. The handoff/item identifiers identify the envelope;
  they do not supply a distinct ID for every transcript entry. These entry
  structs provide no original timestamp, speaker identity, audio, or coverage
  declaration. `ConversationStartParams` separately distinguishes optional
  product voice-session and Realtime API session identifiers.
- [history/src/lib.rs](https://github.com/openai/codex/blob/aff92080f2b8d5f63a63b4ada7b92054287f237c/codex-rs/history/src/lib.rs):
  `RolloutLine` has a string timestamp, optional ordinal and flattened item;
  `RolloutItem` includes `EventMsg`. Missing ordinals are supported. A rollout
  timestamp is evidence about its persisted line, not evidence of the original
  time of speech inside a selected handoff transcript.
- [history/src/rollout_payload.rs](https://github.com/openai/codex/blob/aff92080f2b8d5f63a63b4ada7b92054287f237c/codex-rs/history/src/rollout_payload.rs):
  `RolloutItemWire` uses a snake-case `type` tag and an `EventMsg` payload,
  confirming the fixture's `event_msg` envelope.

The Codex case uses a rollout-shaped user event with no client/event ID or
ordinal. Two identical lines deliberately represent distinct occurrences.
The voice case uses the verified handoff payload fields, with entirely invented
text and envelope IDs. Missing call/thread IDs describe this selected input,
not a claim that the producer can never supply them. No personal logs were read.

## Contract implications to review

Archive identities must remain separate from optional opaque upstream IDs.
Identical text and timestamps cannot alone collapse two occurrences. A replay
needs retained generated IDs or a stable checkpoint/occurrence mapping; this
fixture does not implement that persistence. Missing original timestamps stay
null while capture time remains independently recorded.

The voice case is explicitly partial because it represents a selected handoff
snippet. Its two spoken statements remain two events: the later correction
does not rewrite the earlier statement. `input_transcript` repeats the latest
entry, so blindly archiving both fields as separate speech would duplicate it.
Unknown Codex coverage stays unknown. Neither case proves a complete call,
complete raw session, or available audio. Archive fetch references can support
derived decisions without pretending these partial inputs are full raw calls.

## Existing compatibility and validation evidence

At Pachigraph base `d28c67beb2d5c96c2bb7a7874cbb77b52ba78187`,
`collector/USAGE.md` already documents immutable source files, sanitization,
acknowledged SQLite checkpoints, pending gaps and persisted fallback occurrence
counters. `collector/collector.py::_native_id` permits absent event IDs;
`test_record_ids_use_native_id_or_timestamp_type_occurrence` covers that path.
These are reusable safeguards. The current collector requires timezone-qualified
timestamps and discovers UUID session metadata; the voice case is intentionally
not claimed as supported by that collector. The cases are evidence fixtures,
not currently accepted API ingest envelopes.

Validation for this slice: JSON parsing plus assertions for distinct identical
Codex occurrences, nullable voice metadata, separate correction entries, and
explicit partial/unknown coverage. Shared contract/adapter tests and independent
reviews remain separate dependent tasks.
