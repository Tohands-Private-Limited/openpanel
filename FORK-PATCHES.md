# Fork patches (divergences from upstream)

This fork tracks [Openpanel-dev/openpanel](https://github.com/Openpanel-dev/openpanel).
This file lists every change we carry on top of upstream. Keep it current so
upstream syncs stay painless. Fork code is marked with a `FORK (ToHands)`
comment where it sits inside upstream files.

Last upstream sync: **v3.10.3**. v3.9.1 came in as a history-preserving merge
whose tree is upstream, with each patch below re-ported on top as its own
commit; v3.10.3 was then merged normally.

## How to sync upstream

1. Branch off `develop`, `git merge --no-commit <upstream tag>`, then
   `git read-tree -u --reset <upstream tag>` and commit the merge (tree =
   upstream). This keeps fork history while starting from a clean upstream tree.
2. Re-apply each patch below as its own commit, using this file as the map.
3. Run the tests listed under each patch, plus `bun run typecheck` and
   `bun run test`.

## Client contract (stable — do not change)

Offline-first SDKs (Flutter, LVGL) send batches to `/track`:

```json
{ "type": "batch", "payload": [{ "type": "track", "payload": { ... } }, ...] }
```

and depend on the exact 202 response:

```json
{ "accepted": 3, "rejected": [{ "index": 1, "reason": "validation", "error": "payload.name: ..." }] }
```

`reason` is `validation` (do not retry that item) or `internal` (retry that
item). This envelope matches what upstream asked for in
[PR #377](https://github.com/Openpanel-dev/openpanel/pull/377).

## Permanent fork differences

### CI: image build and publish

`.github/workflows/docker-build.yml` is upstream's workflow adapted to the
fork:
- Triggers only on `develop` / `staging` / `main`.
- Pushes `ghcr.io/tohands-private-limited/openpanel-api` and
  `openpanel-dashboard`, tagged `dev-latest` / `stg-latest` / `latest` plus
  `-<short sha>`.
- Every deploy branch builds amd64 and arm64.
- Upstream's `settle` (debounce) and `version` (release tagging) jobs are
  removed.

Upstream release pipelines that never apply to the fork are deleted:
- `.github/workflows/self-hosting-release.yml` publishes upstream's Docker Hub
  images and GitHub releases when the `self-hosting` tag moves.
- `.github/workflows/sdks.yml` publishes the `@openpanel/*` SDKs to npm.

The api image runs both roles (`ROLE=api|worker|all`). There is no separate
worker image anymore.

### Batch ingestion (`POST /track` with `type: "batch"`)

`packages/core/src/modules/ingest/`:
- `ingest.constants.ts`: `zTrackBatchHandlerPayload` (1–2000 events),
  `zTrackRequestBody` (the single-event union plus `batch`), the result and
  rejection types, `TRACK_BATCH_MAX_BODY_BYTES` (10 MB).
- `ingest.service.ts`: `ingestTrackBatch` runs each item through `ingestTrack`,
  50 at a time. Per item:
  - A schema failure is a `validation` rejection, formatted `path: message`.
  - An item bigger than one Kafka message (`kafka.maxMessageBytes`) is a
    `validation` rejection.
  - A pipeline refusal (alias, too old, ...) is a `validation` rejection with
    the single-event message.
  - A thrown error is an `internal` rejection and is logged.

  `isDuplicateIngestRequest` exempts batch envelopes, because SDKs retry whole
  batches.
- `ingest.routes.ts`:
  - `/track` accepts `zTrackRequestBody` and branches to `ingestTrackBatch`.
  - `refuseOversizedBody` gives a batch envelope the 10 MB cap instead of
    upstream's single-message cap.
  - `respondToBatchOutcome` produces the 202 body.
- Tests: `ingest.batch.test.ts` (service) and `ingest.batch.routes.test.ts`
  (HTTP contract through the real Elysia routes).

### Historical-event session reconstruction

Upstream lets an event older than 15 minutes ("from the past") join the
device's live session, and creates no session for it. Offline-first SDKs upload
genuinely past user sessions, which must appear as real sessions, so the fork
reconstructs them. The two will not converge.

- **5-day floor** (`ingest.service.ts`): `isOlderThanHistoricalFloor`. `/track`
  and `/event` refuse events older than 5 days (`timestamp-too-old` → 400,
  `event timestamp older than 5 days`).
- **Session id** (`ingest.service.ts`): a historical event resolves its
  device/session through `NO_LIVE_SESSIONS` instead of the session buffer, so
  it gets the deterministic timestamp-bucketed session id rather than joining
  the live session. `src/device-id.ts` itself is unchanged from upstream. Both
  `buildContext` (`/track`) and the legacy `/event` path do this.
- **`src/historical-session.ts`** (new): a Redis lock
  (`session_start:<project>:<session>`, TTL = session timeout) so exactly one
  event per bucket emits the `session_start`.
- **`src/incoming-event-handler.ts`** (Kafka consumer):
  - A historical non-server event goes to `ingestHistoricalEvent`. It claims
    the lock, writes `session_start` (100 ms before the event), then writes the
    event without touching live session state.
  - If the `session_start` write fails, the lock is released and the error
    rethrown, so a Kafka redelivery retries it.
  - Every event is stamped with `__syncedAt` (processing time).
  - Server events without a session keep their own referrer fields.
- **`src/ingest.metrics.ts`**: the `sessions_started` kind adds `historical`.
- Tests: `src/incoming-event-handler.test.ts` ("historical session
  reconstruction"), `src/historical-session.test.ts`, and
  `ingest.batch.test.ts`.

Known limit, carried over from the old fork: late uploads for the same bucket
that arrive more than one lock TTL apart produce a second `session_start`.

### Sankey "group nodes by event property" (node label-by rules)

Upstream groups every Sankey node by event name, so all `screen_view`s collapse
into one node. The fork lets an event be labelled by one of its event-level
properties (the default for new reports is `screen_view → path`). Saved reports
without `labelBy` behave exactly as before. No ClickHouse migration is needed.

- `packages/core/src/modules/report/report.constants.ts`:
  `isEventLevelProperty`, `zSankeyLabelRule` (rejects `profile.` / `group.` /
  `cohort:`), the `ISankeyLabelRule` type, and optional `labelBy` on
  `zSankeyOptions`.
- `packages/core/src/modules/chart/`:
  - `labelBy` on `zGetSankeyInput` (`chart.constants.ts`).
  - The label expression and the labelled path pipeline in `src/sankey.sql.ts`
    and `src/sankey-labels.ts`.
  - `labelBy` passed through `sankey.service.ts` and `chart.service.ts`.

  With no effective rule, the SQL is upstream's unchanged.
- `apps/start/src/components/report/`:
  - New `sidebar/SankeyLabelBy.tsx` editor.
  - The "Node label" section in `sidebar/ReportSettings.tsx`.
  - `changeSankeyLabelBy` and `createDefaultSankeyLabelBy` in `reportSlice.ts`.
- Tests: `chart/sankey.label-by.test.ts` and `report/report-slice.test.ts`.

### Events-table identity columns (Profile ID + Mobile)

`apps/start/src/components/events/table/columns.tsx` adds two columns, hidden
by default, that users can turn on from the "View" menu:
- **Profile ID** (`profileIdRaw`): the raw profile id, linked to the profile.
- **Mobile** (`mobile_no`): `profile.properties.mobile_no`, a ToHands trait
  sent via `identify`.

`apps/start/src/components/ui/data-table/data-table-hooks.tsx`:
- Merges stored column visibility over the `meta.hidden` defaults, so columns
  added after a user saved preferences keep their intended default.
- Resolves `accessorKey` when building the column order.

Tests: `events/table/columns.test.tsx` and
`ui/data-table/data-table-hooks.test.tsx`.

### Webhook notification retries

Upstream already marks a failed webhook as retryable or permanent: 408, 429,
5xx and network errors are rethrown; any other 4xx completes the job. The
fork's change is the retry budget, plus treating 408 as retryable:

- `packages/core/src/jobs.registry.ts`: notification queue defaults are
  `attempts: 12` and `backoff: exponential, 10s`. That gives waits of
  10s → 20s → … → 2.8h, about 5.7h in total. Upstream's `removeOnFail` is
  kept.
- `packages/core/src/clients/provider-error.ts`: `REQUEST_TIMEOUT_STATUS`
  (408) is retryable.
- Tests: `jobs.registry.test.ts` (pinned defaults), `provider-error.test.ts`,
  and `clients/integrations/fetcher.test.ts`.

## Temporary patches

### Deprecated `POST /track/batch` route

`ingest.routes.ts` keeps `/track/batch` (`{ "events": [...] }`, schema
`zTrackBatchBody`) for clients shipped before the `/track` envelope existed.
Every call logs a warning with `deprecatedEndpoint: "POST /track/batch"`,
`projectId` and `clientId`.

**Remove when** production shows no such warnings for a comfortable window.
Delete the route, `zTrackBatchBody`, and its test in
`ingest.batch.routes.test.ts`.
