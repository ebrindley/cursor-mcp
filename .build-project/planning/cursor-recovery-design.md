# Recovery follow-up design

These are proposed additions, not shipped tools. The active work items in
`backlog/` carry their scope and acceptance criteria. Implementation requires a
separate task; this design does not authorize new behavior.

## Agent-level evidence bundle

Build on `cursor_export_run` with an explicitly identified agent and bounded run
list. Store agent metadata, runs, usage and individual replay exports beneath an
operator-approved root. Artifact downloads and legacy conversation are optional
members. Walk runs serially with bounded pacing and prefer ERROR/CANCELLED runs.

Resume by skipping complete members. A nonempty partial or a raw file whose
sidecars failed requires explicit operator handling: report its path and state,
continue other members, and never delete, overwrite or append to resolve a
collision. Return bounded totals, statuses and paths, not replay payloads. Include
available branch metadata without treating a branch name as proof of a push.

## Retention guidance

Report a retention duration only when evidence provides it, with its source and
limitations. Do not compute an expiration deadline without an established epoch.
Missing evidence means unknown. Offer recovery guidance on ERROR/CANCELLED runs,
and do not assume a FINISHED run's PR preserves its execution record.

## Bounded artifact reads

Preserve `cursor_get_artifact_url`. A new download tool needs a separate transport
that never forwards the Cursor authorization header and refuses redirects. Bound
both declared and streamed sizes. Sanitize and cap small text; large files require
explicit local storage authorization and the existing no-overwrite contract.
Artifact timestamps are freshness heuristics, not proof of run provenance.

## Legacy conversation reads

A separate, bounded v0 conversation read may return narration through existing
scope checks and sanitization. Label it legacy, explain that it is not a tool-output
archive, and handle an unavailable route. Do not add fan-out to agent listing.

## Deferred scope

Follow-up model overrides need a supported contract and evidence of the effective
model. A request accepting a model-shaped field does not establish model execution.
No scheduler, automatic cloud mutation, launcher changes, or transcript storage is
part of these follow-ups.
