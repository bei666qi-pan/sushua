# Phase 2n — Job status stream

## Scope

- Add the advertised `GET /api/v1/jobs/{job_id}/stream` endpoint.
- Stream complete, tenant-authorized Job snapshots as server-sent events.
- Close explicitly on terminal state, client disconnect, access revocation, or a bounded stream window.
- Keep `async_ingestion` default-off behavior: the route returns `404` without initializing auth or PostgreSQL.

This increment streams deterministic Job state only. AI generation payloads remain out of scope; the later
AI module can wrap model output with the selected AI SDK without changing this Job snapshot contract.

## Protocol

- `retry: 1000` asks EventSource clients to reconnect after a bounded stream closes.
- `event: job` carries a complete v1 Job snapshot, so reconnect does not require replaying an in-memory event log.
- `event: done` carries the terminal state and closes the response.
- `event: reconnect` closes a non-terminal response after 25 seconds to bound Web resources.
- `event: error` exposes only `job_stream_unavailable`; database or tenant details never enter the stream.
- `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` prevent proxy buffering.

## Authorization and recovery

- The initial read uses the same RLS-backed Job module as `GET /api/v1/jobs/{id}`.
- Workspace viewers may observe content-processing progress; unrelated learners receive the same `404` as an
  unknown Job.
- Each poll repeats the tenant-scoped read. If access is revoked while connected, the stream closes.
- PostgreSQL remains the fact source. Reconnection reads the latest snapshot instead of relying on Redis events.

## Verification

- RED: the default-off route test failed because the advertised stream route did not exist.
- RED: the PostgreSQL API test failed because `handlers.STREAM` did not exist.
- GREEN: the default-off route returns `404` without auth/database configuration.
- GREEN: the real PostgreSQL test verifies cross-tenant denial, terminal `done`, and request-abort shutdown.

This document records local and CI evidence only. Production availability is proven separately by the release
workflow and public version check; the feature remains inaccessible while `async_ingestion` is disabled.
