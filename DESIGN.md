# Design

## The problem, restated

Consumers must call one API and pass `courier_partner`. Adding a courier tomorrow must not touch
controllers, unified DTOs, existing adapters, or business logic. That constraint drives everything
below.

## What the courier API actually does

The UrbaneBolt UAT API was called directly before any code was written. Three findings shaped the
architecture more than any pattern did.

**HTTP 200 does not mean success.** A bad pincode, a duplicate order number and a schema violation
all come back `200 OK` with `{"status": "Failed"}` or a populated `errorResponse[]`. The one genuine
HTTP status it uses semantically is `401` for a dead token — and that response has a *different*
body shape (`{"detail": ...}`) from everything else.

**`POST /services/manifest/` is natively batch.** It takes an array and reports per-item outcomes.

**The token is stable with a 24-hour TTL.** Calling `getToken` twice returns the identical string.

Also: a duplicate `orderNumber` is rejected **without returning the AWB**, and there is no
lookup-by-order-number endpoint. That gap is real and is handled explicitly rather than hidden.

Full evidence in [docs/urbanebolt-api-findings.md](docs/urbanebolt-api-findings.md).

## Architecture

```
                  ┌──────────────────────────────────────────┐
   HTTP  ────────▶│  entry-points/api      controllers        │
                  │  entry-points/queue    bulk chunk worker  │
                  └────────────────────┬─────────────────────┘
                                       │  depends on the contract, never a courier
                  ┌────────────────────▼─────────────────────┐
                  │  domain    OrderService · TrackingService │
                  │            BulkOrderService              │
                  └──────┬──────────────────────┬────────────┘
                         │                      │
         ┌───────────────▼──────┐   ┌───────────▼─────────────────────────┐
         │  data-access         │   │  CourierRegistry  (Strategy lookup) │
         │  repositories        │   └───────────┬─────────────────────────┘
         └──────────────────────┘               │
                                    ┌───────────▼───────────┐
                                    │  RetryingAdapter      │  transport failures
                                    │   └ AuthRefreshing    │  dead tokens
                                    │      └ AuditLogging   │  one row per attempt
                                    │         └ UrbaneBolt  │  the only file that
                                    │            MockCourier│  knows the courier
                                    └───────────────────────┘
```

Component-based layout with three layers inside each component, following
[Node Best Practices](https://github.com/goldbergyoni/nodebestpractices). Two components — `orders`
and `couriers` — each with `entry-points` / `domain` / `data-access`, plus `libraries` for
cross-cutting code. Layer-first is right for small apps; this one has two components and two distinct
entry-point kinds (HTTP and queue), which is where that layout stops scaling.

Concrete adapters sit in a top-level `src/integrations/` rather than nested inside the couriers
component. Structurally slightly impure, deliberately: "here is where you add a courier" is the
headline claim and it should be the second thing anyone sees in `src/`.

Cross-component imports go through `index.ts` only, enforced by an ESLint `no-restricted-imports`
rule so CI fails on a deep import rather than relying on discipline.

## Patterns, and what each is actually doing

**Adapter** — one per courier, translating the unified domain model to and from that courier's wire
format. `UrbaneBoltAdapter` is the real one; `MockCourierAdapter` proves the contract holds for
something that is not UrbaneBolt.

**Registry + Factory** — `CourierRegistry` resolves an adapter by id, validates each enabled
courier's configuration at boot, and backs both `GET /couriers` and the `UNKNOWN_COURIER_PARTNER`
error body. Closed for modification, open for extension.

**Strategy** — `courier_partner` selects the adapter at runtime. No service or controller contains a
courier's name.

**Decorator** — retry/backoff, re-authentication and audit logging wrap every adapter uniformly:

```
RetryingCourierAdapter( AuthRefreshingCourierAdapter( AuditLoggingCourierAdapter( adapter ) ) )
```

Order matters and is not arbitrary:

- **Audit innermost** so there is one `courier_api_logs` row per HTTP attempt, not one per logical
  operation.
- **Auth refresh inside retry** so a dead token costs one re-authentication rather than consuming one
  of the transport retry attempts.
- **Retry outermost** so exponential backoff with jitter applies only to genuine transport failures.

**Repository** — data access behind classes that services depend on as types. TypeScript's structural
typing gives substitutability without an interface-per-class ceremony.

### The two hooks that keep the decorators courier-agnostic

A generic retry decorator cannot know that an UrbaneBolt `200` carrying `status: "Failed"` is
permanent while a `502` is transient. So the adapter decides and the decorator obeys:

1. **The adapter sets `retryable` on every `CourierError` it raises.** `RetryingCourierAdapter` only
   reads the flag.
2. **The adapter answers `isAuthFailure(error)` and `invalidateAuth()`.** The adapter knows that
   `401 {"detail": ...}` means the token died; the decorator just asks.

Every result and every `CourierError` also carries an `audit` array — `{ url, requestBody,
responseStatus, responseBody, durationMs }` — so the audit decorator persists calls without knowing
how they were made.

This is the single most important design decision in the repository. Without it, either the
decorators learn about UrbaneBolt or its quirks leak into the services.

## Database schema

```
orders                       one row per business order, order_id UNIQUE (the idempotency key)
  normalized_payload jsonb   our validated input
  request_payload    jsonb   the exact body sent to the courier
  response_payload   jsonb   the exact body received
  status, awb, courier_order_id, label_url, failure_code, failure_message, last_tracked_at

tracking_events              APPEND-ONLY
  UNIQUE (order_id, courier_status_code, event_time)

courier_api_logs             APPEND-ONLY — every call, including retries and re-authentications
  courier_partner, operation, reference, request_id, url,
  request_body, response_status, response_body, duration_ms, attempt, error_code

bulk_batches / bulk_batch_items    per-order outcomes for a bulk submission
```

Requirement 3.3 asks for the request and response "with the order", so they live on the order row.
`courier_api_logs` then captures *every* interaction — tracking polls, cancellations, retries,
token refreshes — with timing and attempt number. The create call is recorded twice; that
duplication buys spec-literal compliance and operational completeness at once.

`courier_api_logs` deliberately has **no foreign key** to `orders`. It stores a `reference` (the
business order id, or the AWB for tracking and cancellation calls). Authentication calls and
chunked batch calls belong to no single order, and a nullable FK would have needed the ambient
request context to populate. A text reference is queryable, always populated, and simpler.

`orders.order_id` is unique **globally**, not per courier — the same order must never ship twice via
different partners.

### Statuses

`PENDING · CREATED · PICKED_UP · IN_TRANSIT · OUT_FOR_DELIVERY · DELIVERED · UNDELIVERED · RTO ·
CANCELLED · FAILED · RECONCILIATION_REQUIRED · UNKNOWN`

The DB enum and the TypeScript union are generated from the same tuple, so they cannot drift.

UrbaneBolt does not publish its scan-code list. `MAN → CREATED` and `CAN → CANCELLED` are confirmed
against the live API; the rest are best-effort. **An unrecognised code maps to `UNKNOWN`, keeps its
raw value on the tracking event, and logs a warning — it never throws and never drops an event.**

## Request flows

### Create

1. Validate with zod; an unknown `courier_partner` is a `400` carrying the supported list.
2. **Insert the order as `PENDING` before calling the courier.** A unique-constraint violation on
   `order_id` is caught and treated as an idempotent replay.
3. Call the courier through the decorator chain.
4. Persist AWB, both raw payloads, and the status — or the failure.

Insert-before-call is what makes a crash recoverable: a `PENDING` row with no AWB is exactly what
reconciliation looks for. A `PENDING` row that already exists is re-driven rather than replayed,
because it means an earlier attempt died before the courier answered.

### Idempotency

A repeated `order_id` returns `200` with the original order and `idempotent_replay: true`. `409`
would be more RESTful, but it makes safe client retries painful — a network blip on the first call
would force the caller to special-case a conflict, which is the opposite of the point.

### Bulk

Synchronously, inside the request: validate each item independently, reject the invalid ones inline
with field-level detail, dedupe within the request, reserve `PENDING` rows, create the batch, group
by courier, chunk by that adapter's `maxBatchSize`, enqueue one BullMQ job per chunk, return `202`
with a `batch_id`.

In the worker: `supportsBatchCreate` decides between one native call for the whole chunk and one call
per order. 100 UrbaneBolt orders at `maxBatchSize: 15` become **7 courier calls, not 100**. The
worker never learns which courier it is talking to.

**Trade-off.** Chunked jobs buy native batching at the cost of coarser retry granularity — a
transport failure re-drives up to 15 orders. That is safe because the courier deduplicates on
`orderNumber`, and any resulting ambiguity lands in `RECONCILIATION_REQUIRED` rather than creating a
duplicate shipment. Per-order jobs would retry more precisely and cost 100 courier calls; the async
contract (`202` + `batch_id` + a status URL) is identical either way.

Transport failures fail the job and BullMQ retries the chunk with exponential backoff. Per-item
business errors are terminal for that order and are never retried.

### Tracking

`GET /orders/{id}/track` calls the courier, diffs the returned scans against stored history, appends
only genuinely new events, and updates the status. `TRACKING_TTL_SECONDS` short-circuits to the
database so a hot polling loop cannot hammer the courier.

The courier returns its full scan list every time; the unique constraint on
`(order_id, courier_status_code, event_time)` is what makes re-reading it append-only instead of
duplicating history.

If the courier is unreachable, tracking fails with a normalized error rather than silently serving
stale data. Returning stale history with a `stale: true` flag would be friendlier and is the obvious
next step; failing loudly was chosen over degrading quietly.

### Timestamps

UrbaneBolt returns `"27 Aug 2026, 17:34"` with no timezone. `Date.parse` reads that in the server's
local zone, which silently shifts every tracking event once deployed outside IST. The adapter parses
it explicitly as IST. A scan whose timestamp cannot be parsed is dropped with a warning rather than
stored — an unparseable time would break the dedup key that makes history append-only, and the raw
payload survives in `courier_api_logs` either way.

## Errors

One envelope for success and failure, with `request_id` on both.

`AppError` carries `isOperational`. An operational error — pincode not serviceable, courier timed
out — becomes a normalized envelope. A programmer error — a `TypeError`, a bad assumption — becomes
a `500` with its stack logged and a generic client message. That single flag is what stops internal
detail leaking.

**The courier's own wording never reaches a caller.** `CourierError` stores the courier's text as
`courierMessage` and exposes our normalized sentence as `message`. The raw text is persisted on the
order, written to `courier_api_logs`, and logged with the request id. `DEBUG_COURIER_ERRORS=true`
appends it to responses in non-production only.

| Code | HTTP |
|---|---|
| `VALIDATION_ERROR` · `MALFORMED_JSON` · `UNKNOWN_COURIER_PARTNER` · `DUPLICATE_IN_REQUEST` · `OPERATION_NOT_SUPPORTED` | 400 |
| `UNAUTHORIZED` | 401 |
| `ROUTE_NOT_FOUND` · `ORDER_NOT_FOUND` · `BATCH_NOT_FOUND` | 404 |
| `SHIPMENT_ALREADY_CANCELLED` · `SHIPMENT_NOT_CANCELLABLE` · `SHIPMENT_NOT_TRACKABLE` · `DUPLICATE_AT_COURIER` · `RECONCILIATION_REQUIRED` | 409 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `COURIER_VALIDATION_ERROR` · `PINCODE_NOT_SERVICEABLE` | 422 |
| `COURIER_RATE_LIMITED` | 429 |
| `INTERNAL_ERROR` | 500 |
| `COURIER_AUTH_ERROR` · `COURIER_UNAVAILABLE` | 502 |
| `COURIER_NOT_CONFIGURED` | 503 |
| `COURIER_TIMEOUT` | 504 |

One centralized `ErrorHandler` is shared by the Express error middleware and the BullMQ failure
handler. Two entry points, one policy — otherwise they drift.

`X-Request-Id` is generated if absent, echoed on every response, and attached to every log line and
audit row via `AsyncLocalStorage`, so no logger has to be threaded through the call stack. The retry
decorator stamps the attempt number on that same ambient context, because it sits *outside* the
audit decorator and cannot pass the number down the call chain.

## Configuration

Everything comes from the environment through a zod schema validated at boot. A missing or malformed
variable stops the process and names the variable, rather than failing on the first order at 3am.
Each courier validates its own configuration with its own schema inside its own folder.

Retry settings are read by naming convention — `<COURIER>_RETRY_ATTEMPTS`, `_RETRY_BACKOFF_MS`,
`_RETRY_MAX_BACKOFF_MS` — so a new courier gets configurable resilience without editing the
composition root.

A bare `API_KEY=` in a `.env` file becomes an empty string rather than being unset, which would fail
a min-length check instead of falling back to the default. Blank values are stripped before parsing.

## Testing

66 tests: unit on the pure pieces, integration on the real Express app.

Unit tests cover the request mapper, the status map including unmapped codes and IST parsing, the
error classifier that decides a `200` was actually a failure, and each decorator in isolation —
including that the composed chain spends one re-authentication *without* consuming a transport retry.

Integration tests run the real app against real Postgres and Redis with UrbaneBolt intercepted by
nock: `200`-with-`status: Failed`, `401` refresh-and-retry, `502` retry then graceful failure, `502`
then recovery, idempotent replay, unmapped status codes, append-only tracking across two polls, bulk
partial success, and that 20 orders produce 2 manifest calls rather than 20.

Tests must be capable of failing. The leak-prevention assertion was verified by mutating `failure()`
to always expose internals and confirming the test caught it.

## Surviving dependency outages

Three failures were found by stopping Postgres and Redis under a running API, and each is fixed
rather than documented away.

**An outage used to kill the process.** `ioredis` reports connection failures as `error` events and
`pg` does the same for idle clients. With no listener Node promotes them to uncaught exceptions, and
the fail-fast handler exited. Both clients now have listeners, so a Redis blip degrades bulk
processing instead of taking down order creation, which does not need Redis at all.

**The readiness probe used to hang.** BullMQ requires its Redis client to be created with
`maxRetriesPerRequest: null`, which means a command issued while the connection is down queues
forever. A health endpoint that hangs is worse than one that fails, so every probe is bounded at two
seconds and reports the timeout as the failure.

**The worker used to stop consuming for good.** A BullMQ worker that loses Redis during a blocking
read comes back reporting `isRunning() === true` while silently processing nothing — reproduced in
isolation with a plain Queue/Worker pair on bullmq 6, so `isRunning()` cannot be trusted as a signal.
`superviseWorker` watches the queue instead: jobs waiting with nothing active across two consecutive
checks means the worker is not reading, and it is replaced. Verified end to end — a batch submitted
during an outage completes about four seconds after Redis returns.

The false-positive cost is low: replacing a healthy worker only loses the blocking read it was
sitting on, and it takes two consecutive stalled checks to trigger.

## Health probes

`/health` is liveness and touches nothing, so a database outage cannot make an orchestrator kill a
process that is fine. `/health/ready` probes Postgres, Redis and the courier registry in parallel,
returns `503` naming whichever is down, and stays reachable when the API key guard is on.

## Trade-offs and what is deliberately not here

**No circuit breaker.** Retry, backoff and timeouts only. A breaker is the natural next step once
there is more than one courier under real load.

**Single tenant.** `order_id` is globally unique. A tenant column is the obvious extension.

**Create does not pre-check serviceability.** It costs a round trip and the courier validates anyway.
The endpoint is exposed for callers who want the check.

**No automated reconciliation sweeper.** Failed and `RECONCILIATION_REQUIRED` orders are queryable
via `GET /orders?status=FAILED`, and `POST /orders/{id}/retry` re-drives one. A cron sweeper is
documented rather than built.

**A retried create that silently succeeded cannot be auto-reconciled.** Requirement 3.5 mandates
retrying on 5xx and timeouts. If the retry comes back `orderNumber already shipped!`, the shipment
exists but the courier returns no AWB and offers no lookup-by-order-number endpoint. The order is
marked `RECONCILIATION_REQUIRED`, both raw payloads are persisted, and an error is logged with the
order id and request id. `POST /retry` refuses such an order rather than risking a duplicate
shipment. This is a genuine gap in the courier's API, and guessing would be worse than surfacing it.

**Only two UrbaneBolt status codes are verified.** The rest of the map is best-effort and safe by
default. Confirming the full list with UrbaneBolt is a one-email fix.
