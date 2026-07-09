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

### Events-table identity columns (Profile ID + Mobile)

`apps/start/src/components/events/table/columns.tsx` adds two opt-in
(hidden-by-default) columns to the events table, both surfaced through the
existing column-visibility ("View") menu and persisted per-user in localStorage:

- **Profile ID** (`id: 'profileIdRaw'`) — renders the raw `profile.id`
  (falls back to the event's `profileId`) as a link to the profile. Distinct
  column `id` because the existing "Profile" column already owns
  `accessorKey: 'profileId'`.
- **Mobile** (`id: 'mobile_no'`) — renders `profile.properties.mobile_no`, a
  ToHands-specific custom trait sent via `identify` (OpenPanel has no
  first-class phone/mobile field; it lives in the profile `properties` map).

Upstream is not expected to add a `mobile_no` column (fork-specific business
field), so re-apply both on every sync.

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

### Sankey "group nodes by event property" (node label-by rules)

Upstream's flow/Sankey report groups every event by its **name**, collapsing all
`screen_view` events (the bulk of mobile traffic) into one node and hiding
screen-to-screen flow. The fork adds a per-event **node label-by** option: an
event can be grouped by one of its event-level properties (default
`screen_view → path`) while every other event keeps its name. Upstream has no
equivalent — a candidate to contribute upstream, but until then re-apply on
every sync. The feature adds new files and edits files that also exist upstream:

- `packages/validation/src/index.ts` — `isEventLevelProperty` guard,
  `zSankeyLabelRule` (refine rejects `profile.`/`group.`/`cohort:` dimensions),
  and `labelBy: zSankeyLabelRule[].default([])` on `zSankeyOptions`.
- `packages/db/src/services/sankey.service.ts` — `buildSankeyLabelExpr` (the
  `multiIf` label expression, gated by `isEventLevelProperty` **and**
  `isKnownEventField` so unknown columns can't reach `getSelectPropertyKey`),
  the `(name, label)` tuple pipeline across after/before/between modes,
  `labelBy` on `zGetSankeyInput`, and the `labelBy` param on `getUserFlowCore`.
- `packages/trpc/src/routers/chart.ts` — threads `labelBy` through the `sankey`
  procedure.
- `apps/start/src/components/report/sidebar/SankeyLabelBy.tsx` — **new** UI
  editor for the rules.
- `apps/start/src/components/report/sidebar/ReportSettings.tsx` — renders the
  "Node label" section for Sankey charts.
- `apps/start/src/components/report/reportSlice.ts` — `changeSankeyLabelBy`
  reducer + `createDefaultSankeyLabelBy` (seeds `screen_view → path` on new
  Sankey reports).
- Tests: `packages/db/src/services/sankey.service.test.ts`
  (`buildSankeyLabelExpr` unit tests + `getSankey` ClickHouse integration).

Fully back-compatible: saved reports without `labelBy` deserialize to `[]` and
behave exactly as before; no ClickHouse migration.

### Webhook notification retries

Upstream's `notificationQueue` runs webhooks fire-and-forget: no `attempts`, no
`backoff`, and the worker `return`s the raw `fetch` promise so HTTP 4xx/5xx
responses are treated as success. The fork retries failed webhooks aggressively:

- `packages/queue/src/queues.ts` — `notificationQueue.defaultJobOptions` sets
  `attempts: 12`, `backoff: { type: 'exponential', delay: 10000 }`, and
  `removeOnFail: 100`. Waits between attempts:
  10s → 20s → 40s → 80s → 160s → 5m → 10m → 21m → 43m → 1.4h → 2.8h.
  Max wall-clock retry window ≈ 5.7h per job; only 12 outbound HTTP requests
  to a dead receiver in the whole window.
- `apps/worker/src/jobs/notification.ts` — the webhook branch now `await`s
  `fetch` (with a 30s `AbortSignal.timeout` so a hung endpoint can't pin a
  worker slot) and throws on non-2xx so BullMQ observes HTTP failures.
  Permanent 4xx responses (excluding 408 / 429) throw `UnrecoverableError`
  so BullMQ skips the remaining retries — no point re-sending a 400 or 401
  twelve times. Slack/Discord branches unchanged (their helpers keep their
  existing behavior; only network errors — not HTTP status — trigger retries
  for them, which is the same as before).

The queue-level retry config applies to every job type on `notificationQueue`,
but only the webhook branch was changed to surface HTTP failures as thrown
errors. Discord's helper (`packages/integrations/src/discord.ts`) still
swallows errors via `.catch()`, so Discord failures never retry. Slack's
helper returns the raw fetch, so Slack network failures now retry 500× — an
acceptable side-effect. Upstream may add its own retry policy later; if so,
prefer keeping the fork's numbers unless upstream's are stricter.

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
