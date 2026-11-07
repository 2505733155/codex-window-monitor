# Development guidance

Read README.md before making changes. Keep user documentation and the source overview there. Keep personal notes, execution ledgers, generated plans and real session/window snapshots out of the repository; do not create progress documents or task boards unless explicitly requested.

## Architecture constraints

- Preserve read-only Codex IPC, localhost binding, random access credentials and Host/Origin validation.
- Reconcile ownership and revisions per session. Aggregate visible rows by hostId + ownerClientId, never by directory alone.
- Window status priority is busy, attention, unknown, then idle. A window is idle only when all its sessions are idle.
- Missing snapshots, revision gaps, disconnections and incompatible protocols must invalidate confirmed status and trigger recovery where supported.
- Preserve lower-bound duration labels when the start time is uncertain, and keep continuous window timing independent of the representative session.
- Preserve single-instance behavior and automatic shutdown after the last page disconnects. Release collector, HTTP and native-helper resources on shutdown.
- Validate native window identity before activation; require user selection when matching is ambiguous. Keep bindings in memory for the current service instance.
- Retain only minimal status metadata. Do not persist chat content, reasoning or tool output, or send task-control commands to Codex.

## Repository hygiene

Keep changes focused and use checks appropriate to their scope. Report only checks actually performed; distinguish protocol fixtures, live IPC observations and browser/native UI validation.

Preserve ignored local prompts/ and .runtime/ data during cleanup. Use synthetic, sanitized examples in documentation and fixtures. Add third-party dependencies only when needed and document why.

Commit, rewrite history, push, publish or create a remote repository only when requested.
