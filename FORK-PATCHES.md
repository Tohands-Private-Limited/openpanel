# Fork patches (temporary divergences from upstream)

This fork tracks [Openpanel-dev/openpanel](https://github.com/Openpanel-dev/openpanel).
This file lists changes we carry that are **expected to be replaced by upstream
work** — keep it current so upstream syncs stay painless.

## Client contract (stable — do not change)

Clients send batches to the **existing** `/track` endpoint:

```json
{ "type": "batch", "payload": [{ "type": "track", "payload": { ... } }, ...] }
```

This matches the contract requested by upstream in
[PR #377](https://github.com/Openpanel-dev/openpanel/pull/377), so when
upstream merges batch support, clients need no changes.

## Permanent fork differences

- `.github/workflows/docker-build.yml` — our Docker build/publish pipeline
  (triggers on develop/staging/main). Keep our side on upstream syncs.
- `FORK-PATCHES.md` (this file).

## Temporary patches

### 1. Worker-side historical-event/session handling

Upstream's session management is wall-clock dependent; the maintainer is
reworking it (see PR #377 discussion, 2026-06-04). Until that lands, we carry
our own implementation:

- `apps/worker/src/jobs/events.incoming-event.ts` — deterministic
  session handling for historical events, Redis-lock dedup of
  `session_start`, live-vs-historical event split
- `apps/worker/src/jobs/events.incoming-events.test.ts` — tests for the above
- `apps/api/src/utils/ids.ts` — deterministic 30-min session bucketing keyed
  on the event's own `__timestamp` (`eventMs`)
- `packages/queue/src/queues.ts` — dropped `isTimestampFromThePast` from the
  queue payload (replaced by the worker's own live/historical detection)
- `apps/api/src/controllers/event.controller.ts` — passes `eventMs`,
  no longer forwards `isTimestampFromThePast`
- 5-day hard floor for historical timestamps in
  `apps/api/src/controllers/track.controller.ts` (`getTimestamp` throws 400)

**On upstream sync:** when upstream's session rework lands, resolve conflicts
in these files by taking upstream's side wholesale, then re-run
`apps/api/src/routes/track-batch.router.test.ts` and
`apps/worker/src/jobs/events.incoming-events.test.ts` and re-validate
historical-event ingestion end to end.

### 2. Deprecated `POST /track/batch` route

`apps/api/src/routes/track.router.ts` keeps `/track/batch`
(body `{ "events": [...] }`) as a deprecated alias for clients shipped before
the `/track` envelope existed. The canonical transport is `/track` with
`type: "batch"`.

**Remove when:** no client traffic hits `/track/batch` anymore. Every call
emits a warn log from `batchHandler` (`deprecatedEndpoint: "POST /track/batch"`
with `projectId`/`clientId`) — when production shows no such lines for a
comfortable window, delete the route, `batchHandler`,
`zTrackBatchBody`/`ITrackBatchBody`, and the legacy transport block in
`track-batch.router.test.ts`.
