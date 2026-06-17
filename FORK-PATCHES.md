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

These are deliberate divergences upstream is **not** expected to adopt — keep
our side on every sync.

- `.github/workflows/docker-build.yml` — our Docker build/publish pipeline
  (triggers on develop/staging/main).
- `FORK-PATCHES.md` (this file).

### Historical-event session reconstruction

As of the upstream **#393** session-management sync we **adopt upstream's
`sessionBuffer.ingest` lifecycle** for live traffic (the old BullMQ
`createSessionEndJob`/`getActiveSessionEndJob` mechanism is gone). On top of it
we keep one deliberate product difference: **late / offline-uploaded events
reconstruct a real session**, whereas upstream deliberately suppresses session
creation for anything older than 15 minutes ("no artificial sessions from
historical imports"). Offline-first SDKs (Flutter / LVGL on embedded devices)
upload genuinely past user sessions, and those must appear as sessions in
analytics — so the two will not converge.

An event is "historical" when the API flags `isTimestampFromThePast` (its
`__timestamp` is > 15 min old). Files carrying the divergence:

- `apps/api/src/controllers/track.controller.ts` — `getTimestamp` keeps the
  fork's 5-day hard floor (throws 400) layered on upstream's 15-min
  `isTimestampFromThePast`; threads the flag + `eventTimeMs` into `getDeviceId`
  and the queue payload.
- `apps/api/src/controllers/event.controller.ts` — deprecated `/event` threads
  the same flag + `eventTimeMs`.
- `apps/api/src/utils/ids.ts` — fork `isTimestampFromThePast` param that
  **skips the live-session lookup** for historical events, so a backfill gets a
  deterministic timestamp-bucketed id instead of joining the device's live
  session.
- `packages/queue/src/queues.ts` — `isTimestampFromThePast` on the
  incoming-event payload (the worker's reconstruction arm reads it). NOTE: a
  prior fork patch *dropped* this field; the #393 sync re-adds it — do not drop
  it again.
- `apps/worker/src/jobs/events.incoming-event.ts` — the reconstruction arm:
  for a non-server historical event, emit one `session_start` per
  `(project, sessionId)` bucket (Redis-lock dedup via `acquireSessionStartLock`)
  and write the event **without** touching live session state (no
  `sessionBuffer.ingest`, no `sessionEnd`). Also stamps a `__syncedAt`
  processing timestamp on every event.
- Tests: `apps/api/src/utils/ids.test.ts` (skip-lookup),
  `apps/api/src/controllers/track.controller.test.ts` (`getTimestamp`),
  `apps/worker/src/jobs/events.incoming-events.test.ts` (reconstruction arm).

**On future upstream syncs:** take upstream's `packages/db` session-buffer,
`ids.ts` live-lookup, and worker live-path changes wholesale, then re-apply the
fork hooks above (5-day floor, `ids.ts` skip-lookup, the worker reconstruction
arm + `__syncedAt`, and the queue `isTimestampFromThePast` field). Re-run
`ids.test.ts`, `track.controller.test.ts`, `events.incoming-events.test.ts`,
and `track-batch.router.test.ts`.

## Temporary patches

### 1. Deprecated `POST /track/batch` route

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
