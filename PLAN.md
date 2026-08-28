# Multi-Courier Integration Platform — Build Plan

Working document for the build. Feeds `DESIGN.md` at the end; not a deliverable itself.

---

## 1. What the API actually does (verified, not assumed)

The UrbaneBolt UAT API was probed live before designing. Three findings drive most of this plan:

| Finding                                                                                                                                                                                                                                | Consequence                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **HTTP 200 ≠ success.** Business errors return `200` with `{"status":"Failed"}` or a populated `errorResponse[]` / `failureResponse[]`. Only an expired token returns a real `401`, with a _different_ body shape (`{"detail": ...}`). | Success/failure classification lives in the **adapter**, never in a shared HTTP client or a generic decorator. |
| **`POST /services/manifest/` is natively batch** — takes an array, returns `successResponse[]` + `errorResponse[]` with per-item outcomes.                                                                                             | Adapters declare a `supportsBatchCreate` capability. 100 orders become ~7 chunked calls, not 100.              |
| **Token is stable, 24h TTL** — repeated `getToken` returns the identical token until expiry.                                                                                                                                           | Cache per courier; invalidate and retry once on auth failure.                                                  |

Also observed: `errorResponse` (manifest) vs `failureResponse` (cancel) — inconsistent keys. Duplicate `orderNumber` is rejected with **no AWB returned**, and there is **no lookup-by-orderNumber endpoint**. That gap is the reason for the `RECONCILIATION_REQUIRED` state in §7.

Full endpoint/payload reference: [docs/urbanebolt-api-findings.md](docs/urbanebolt-api-findings.md).
Upstream collection archived at [docs/urbanebolt.postman_collection.json](docs/urbanebolt.postman_collection.json).

---

## 2. Decisions

| Area              | Decision                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope             | Strong signal, ~1–2 days                                                                                                                                            |
| Stack             | Express + TypeScript (Node 22)                                                                                                                                      |
| Persistence       | Postgres + Drizzle ORM                                                                                                                                              |
| Validation        | zod (requests, courier configs, env)                                                                                                                                |
| Queue             | BullMQ + Redis                                                                                                                                                      |
| Plug-in discovery | Self-registering barrel — new folder + one import line                                                                                                              |
| Wiring            | Hand-written composition root, constructor injection                                                                                                                |
| Batch handling    | `capabilities` object + optional batch method on the adapter                                                                                                        |
| Cross-cutting     | Decorator chain around the adapter                                                                                                                                  |
| Unified DTO       | Strict, no courier passthrough                                                                                                                                      |
| Idempotency       | `200` + original result + `idempotent_replay: true`                                                                                                                 |
| Tracking          | Live call, TTL-guarded, append-only diff                                                                                                                            |
| Responses         | Envelope on success and failure; normalized codes; raw kept server-side                                                                                             |
| Bulk job unit     | One job per chunk, grouped by courier                                                                                                                               |
| Create retry      | Retry on transport failure; duplicate-on-retry ⇒ `RECONCILIATION_REQUIRED`                                                                                          |
| Tests             | Vitest — unit on pure logic, integration via supertest + nock, Postgres via testcontainers                                                                          |
| MockCourier       | Deterministic fake with configurable failure injection                                                                                                              |
| Audit             | jsonb on `orders` _and_ append-only `courier_api_logs`                                                                                                              |
| Topology          | Separate `server.ts` / `worker.ts`; `WORKER_INLINE=true` for dev                                                                                                    |
| Reconciliation    | Persist + queryable + manual retry endpoint                                                                                                                         |
| Offline stack     | WireMock as a compose service; nock stays in tests                                                                                                                  |
| Statuses          | Wide canonical enum + `UNKNOWN` fallback, raw code always retained                                                                                                  |
| Tooling           | ESLint + Prettier + tsx + Vitest                                                                                                                                    |
| Structure         | Component-based with three layers per component ([Node Best Practices](https://github.com/goldbergyoni/nodebestpractices)); adapters hoisted to `src/integrations/` |
| API docs          | zod → OpenAPI → Swagger UI → Postman, one source of truth                                                                                                           |
| Extras            | Dockerfile + compose, GitHub Actions CI, seed + demo script                                                                                                         |

**Code style:** [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — TypeScript rules, error-handling policy,
where SOLID does real work here, and what keeps the code from reading as machine-generated. The
mechanically checkable half is ESLint rules, not prose.

---

## 3. Design patterns and where each earns its place

- **Adapter** — one per courier, translating the unified domain model to and from that courier's wire format. `UrbaneBoltAdapter`, `MockCourierAdapter`.
- **Registry + Factory** — `CourierRegistry` holds descriptors keyed by id; resolves an adapter instance, validates that courier's config at boot, and backs both `GET /couriers` and the `UNKNOWN_COURIER_PARTNER` error body.
- **Strategy** — `courier_partner` on the request selects the adapter at runtime. Services depend on `CourierAdapter`, never on a concrete courier.
- **Decorator** — retry/backoff, auth refresh, and audit logging wrap every adapter uniformly. Adding a courier inherits all three for free.
- **Repository** — data access behind interfaces so services stay persistence-agnostic and unit-testable.

Deliberately _not_ used: no Abstract Factory (one product family, it would be ceremony), no circuit breaker (out of budget; noted as future work in `DESIGN.md`).

---

## 4. The courier contract

```ts
type CourierCapabilities = {
  supportsBatchCreate: boolean;
  maxBatchSize: number;
  supportsCancel: boolean;
  supportsServiceability: boolean;
};

interface CourierAdapter {
  readonly id: string;
  readonly capabilities: CourierCapabilities;

  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>>;
  createShipments?(orders: NormalizedOrder[]): Promise<CourierResult<ShipmentCreated>[]>;
  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>>;
  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>>;
  checkServiceability?(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>>;

  isAuthFailure(error: unknown): boolean;
  invalidateAuth(): Promise<void>;
}
```

Two details make the decorators possible without leaking courier knowledge:

1. **Every result and every `CourierError` carries an `audit` payload** — `{ url, requestBody, responseStatus, responseBody, durationMs }`. The audit decorator persists it; it never has to know how the call was made.
2. **The adapter sets `retryable` on `CourierError`.** The retry decorator only obeys the flag. So "a 200 with `status: Failed` is a permanent business error, a 502 is transient" is a fact the UrbaneBolt adapter owns, and the decorator stays courier-agnostic.

`isAuthFailure` / `invalidateAuth` do the same job for the auth-refresh decorator — the adapter knows that `401 {"detail": ...}` means the token died; the decorator just asks.

### Decorator composition order

```
RetryDecorator( AuthRefreshDecorator( AuditLogDecorator( UrbaneBoltAdapter ) ) )
```

- Audit innermost ⇒ **one `courier_api_logs` row per HTTP attempt**, with the attempt number.
- Auth refresh inside retry ⇒ a dead token costs one re-auth, not one of the transport retry attempts.
- Retry outermost ⇒ exponential backoff with jitter across genuine transport failures only.

### Adding a courier (the README's headline claim)

```
src/integrations/delhivery/
  index.ts            <- exports delhiveryDescriptor: CourierDescriptor
  delhivery.adapter.ts
  delhivery.client.ts
  delhivery.mapper.ts
  delhivery.status-map.ts
  delhivery.errors.ts
  delhivery.config.ts <- zod schema for its env vars
```

plus one import line in `src/integrations/index.ts`. Controllers, DTOs, services, and existing adapters are untouched — the four things requirement 3.2 prohibits changing.

---

## 5. Directory layout

Component-based, three layers inside each component, following the
[Node Best Practices](https://github.com/goldbergyoni/nodebestpractices) layout
(`entry-points` / `domain` / `data-access` per component, `libraries/` for cross-cutting code).
Layer-first is the right call for small apps; this one has two real components and two distinct
entry-point types (HTTP and queue), which is exactly where that layout stops scaling.

Concrete adapters are hoisted to a top-level `src/integrations/` rather than nested inside the
couriers component — structurally slightly impure, but "here is where you add a courier" is the
headline claim of this assignment and it should be the second thing anyone sees in `src/`.
Named `integrations` rather than `couriers` so it cannot be confused with
`components/couriers`, which holds the contract and registry rather than any concrete courier.

```
src/
  server.ts                          API process entry
  worker.ts                          queue worker process entry
  app.ts                             express assembly
  container.ts                       composition root — the whole object graph on one screen
  components/
    orders/
      index.ts                       public interface — the only path other components import
      entry-points/
        api/                         orders.routes · orders.controller · orders.schemas
        queue/                       bulk-create.processor
      domain/                        order · bulk-order · tracking · reconciliation services
                                     order-status · order.types
      data-access/                   order · tracking-event · bulk-batch repositories
                                     schema.ts (drizzle tables owned by this component)
    couriers/
      index.ts                       public interface — registry + contract types
      entry-points/api/              GET /couriers · GET /serviceability
      domain/
        courier.interface.ts         the contract from §4
        courier.registry.ts
        courier.types.ts             NormalizedOrder · TrackingSnapshot · CourierResult
        courier.errors.ts
        decorators/                  retry · auth-refresh · audit-log
      data-access/                   courier-api-log repository · schema.ts

  integrations/                      <<< ADD A NEW COURIER HERE
    index.ts                         the barrel — one import line per courier
    urbanebolt/
      index.ts                       exports urbaneBoltDescriptor
      urbanebolt.adapter.ts  .client.ts  .mapper.ts
      urbanebolt.status-map.ts  .errors.ts  .config.ts
    mock/

  libraries/
    config/                          zod-validated env
    logger/                          pino, request-id bound
    errors/                          AppError · error codes · HTTP mapping
    http/                            request-id · api-key · validate · error-handler · envelope
    openapi/                         registry · spec builder · Swagger UI mount
    queue/                           BullMQ connection + queue factory

  db/
    client.ts
    schema.ts                        re-exports component tables for drizzle-kit
    migrations/

tests/           unit/ · integration/
wiremock/        mappings/ — offline UrbaneBolt stubs
postman/ · scripts/ · docs/
```

**Cross-component imports go through `index.ts` only.** `orders` may import from
`components/couriers`, never from `components/couriers/domain/...`. Enforced by an ESLint
`no-restricted-imports` rule so the boundary is checked by CI, not by discipline.

Drizzle tables are owned by the component that uses them; `src/db/schema.ts` is a barrel that
re-exports them for `drizzle-kit`, which needs a single entry point.

---

## 6. Database schema

```
orders
  id                  uuid pk
  order_id            text UNIQUE NOT NULL       -- caller's id; the idempotency key
  courier_partner     text NOT NULL
  courier_order_id    text
  awb                 text
  status              order_status NOT NULL
  payment_mode        payment_mode NOT NULL
  service_level       service_level NOT NULL
  collectable_amount  numeric
  declared_value      numeric
  label_url           text
  normalized_payload  jsonb NOT NULL             -- our validated input
  request_payload     jsonb                      -- exact body sent to courier (create)
  response_payload    jsonb                      -- exact body received (create)
  metadata            jsonb
  failure_code        text
  failure_message     text
  last_tracked_at     timestamptz                -- drives the tracking TTL guard
  created_at, updated_at timestamptz NOT NULL
  INDEX (status), INDEX (courier_partner), INDEX (awb)

tracking_events                                   APPEND-ONLY
  id                  uuid pk
  order_id            uuid fk -> orders.id
  status              order_status NOT NULL       -- canonical
  courier_status_code text NOT NULL               -- raw, always retained
  courier_status_description text
  reason_code, reason_description text
  location            text
  event_time          timestamptz NOT NULL
  raw_payload         jsonb NOT NULL
  created_at          timestamptz NOT NULL
  UNIQUE (order_id, courier_status_code, event_time)   -- makes the diff idempotent

courier_api_logs                                  APPEND-ONLY
  id, order_id fk NULL, courier_partner, operation,
  request_id, url, request_body jsonb, response_status,
  response_body jsonb, duration_ms, attempt, error_code, created_at
  INDEX (order_id), INDEX (request_id), INDEX (created_at)

bulk_batches
  id uuid pk, status batch_status, total_count, accepted_count,
  rejected_count, succeeded_count, failed_count, created_at, completed_at

bulk_batch_items
  id, batch_id fk, order_id text, courier_partner, status,
  awb, error_code, error_message, created_at, updated_at
  UNIQUE (batch_id, order_id)
```

`UNIQUE (order_id)` on `orders` is global, not per-courier — the same order must not ship twice via different partners.

**Canonical statuses:** `CREATED · PICKED_UP · IN_TRANSIT · OUT_FOR_DELIVERY · DELIVERED · UNDELIVERED · RTO · CANCELLED · FAILED · UNKNOWN`
plus the operational states `PENDING` (row written, courier not yet called) and `RECONCILIATION_REQUIRED`.

UrbaneBolt status map — verified: `MAN → CREATED`, `CAN → CANCELLED`. UrbaneBolt does not publish its full code list, so the remaining entries are seeded as best-effort and flagged in `DESIGN.md` as pending confirmation. **An unmapped code maps to `UNKNOWN`, retains its raw value, and logs a warning — it never throws and never drops the event.**

---

## 7. Request flows

### Single create — `POST /api/v1/orders`

1. zod-validate the body; unknown `courier_partner` ⇒ `400 UNKNOWN_COURIER_PARTNER` with the supported list.
2. Insert the order row as `PENDING` **before** calling the courier. Unique violation on `order_id` ⇒ return the existing order, `200`, `idempotent_replay: true`.
3. Resolve the adapter, call `createShipment` through the decorator chain.
4. Persist AWB, `courier_order_id`, label URL, both raw payloads; status `CREATED`. Seed a `tracking_events` row.
5. On failure: persist `failure_code` / `failure_message`, status `FAILED`, return the normalized error.

Insert-before-call is what makes a crash recoverable: a `PENDING` row with no AWB is exactly what reconciliation looks for.

### Bulk create — `POST /api/v1/orders/bulk`

Synchronous phase, inside the request:

1. Envelope check — non-empty, ≤ `BULK_MAX_ORDERS` (100).
2. zod-validate each item; invalid items are rejected inline with index + field errors and never queued.
3. Dedup within the request on `order_id` ⇒ `DUPLICATE_IN_REQUEST`.
4. Insert `PENDING` rows in a transaction; unique violations reported as duplicates with the existing AWB.
5. Create `bulk_batches` + `bulk_batch_items`.
6. Group accepted orders by `courier_partner`, chunk by that adapter's `maxBatchSize` (1 when it has no batch support), enqueue one job per chunk.
7. Return `202` — `{ batch_id, accepted_count, rejected_count, rejected_items[], status_url }`.

Worker:

- Resolve the adapter. `supportsBatchCreate && chunk.length > 1` ⇒ one native `createShipments` call; otherwise map `createShipment` over the chunk.
- Persist per-order outcomes and update `bulk_batch_items`.
- **Transport failures retry the whole chunk** with BullMQ backoff. **Per-item business errors are terminal for that order** and are never retried.
- 100 orders on UrbaneBolt at `maxBatchSize: 15` ⇒ 7 courier calls.

`GET /api/v1/batches/{batch_id}` returns `PROCESSING | COMPLETED | COMPLETED_WITH_ERRORS`, counts, and per-order results.

**Trade-off to document:** chunked jobs buy native batching and far fewer courier calls, at the cost of coarser retry granularity — a transport failure re-drives up to 15 orders. That is safe because the courier deduplicates on `orderNumber`, and any resulting ambiguity lands in `RECONCILIATION_REQUIRED` rather than creating a duplicate shipment.

### Track — `GET /api/v1/orders/{order_id}/track`

If `last_tracked_at` is within `TRACKING_TTL_SECONDS`, serve from the DB. Otherwise call the courier, diff the returned scans against stored events (dedup on `courier_status_code + event_time`), append only genuinely new ones, update `status` and `last_tracked_at`.

### Cancel — `POST /api/v1/orders/{order_id}/cancel`

Call the courier, map `"Shipment already cancelled!"` ⇒ `409 SHIPMENT_ALREADY_CANCELLED`, set status `CANCELLED`, append a tracking event.

### Reconciliation

`GET /api/v1/orders?status=FAILED` (and `RECONCILIATION_REQUIRED`) lists stuck orders; `POST /api/v1/orders/{order_id}/retry` re-drives one through the same pipeline. An automated sweeper is documented as the next step, not built.

---

## 8. Errors

Every response uses the same envelope.

```jsonc
// success
{ "success": true, "data": { … }, "request_id": "req_01J…" }

// failure
{ "success": false,
  "error": { "code": "PINCODE_NOT_SERVICEABLE",
             "message": "Delivery pincode is not serviceable by this courier",
             "details": [{ "field": "delivery.pincode", "issue": "not_serviceable" }],
             "courier_partner": "urbanebolt",
             "retryable": false },
  "request_id": "req_01J…" }
```

| Code                                                      | HTTP                                |
| --------------------------------------------------------- | ----------------------------------- |
| `VALIDATION_ERROR`                                        | 400                                 |
| `UNKNOWN_COURIER_PARTNER`                                 | 400 (body lists supported couriers) |
| `DUPLICATE_IN_REQUEST`                                    | 400                                 |
| `OPERATION_NOT_SUPPORTED`                                 | 400 (capability absent)             |
| `ORDER_NOT_FOUND` / `BATCH_NOT_FOUND`                     | 404                                 |
| `SHIPMENT_ALREADY_CANCELLED` / `SHIPMENT_NOT_CANCELLABLE` | 409                                 |
| `RECONCILIATION_REQUIRED`                                 | 409                                 |
| `COURIER_VALIDATION_ERROR` / `PINCODE_NOT_SERVICEABLE`    | 422                                 |
| `COURIER_RATE_LIMITED`                                    | 429                                 |
| `INTERNAL_ERROR`                                          | 500                                 |
| `COURIER_AUTH_ERROR` / `COURIER_UNAVAILABLE`              | 502                                 |
| `COURIER_NOT_CONFIGURED`                                  | 503                                 |
| `COURIER_TIMEOUT`                                         | 504                                 |

The courier's raw error never reaches the client. It is persisted on the order and in `courier_api_logs`, and logged with `order_id`, `courier_partner`, `request_id`, and error type. `DEBUG_COURIER_ERRORS=true` surfaces raw detail in non-production only.

`X-Request-Id` is generated if absent, echoed on every response, and attached to every log line and audit row.

---

## 9. Configuration

Nothing hardcoded. `config/env.ts` parses and validates `process.env` with zod at boot and fails fast.

```
PORT · NODE_ENV · LOG_LEVEL · API_KEY · DEBUG_COURIER_ERRORS
DATABASE_URL · REDIS_URL
BULK_MAX_ORDERS=100 · BULK_WORKER_CONCURRENCY=5 · BULK_JOB_ATTEMPTS=3 · BULK_BACKOFF_MS=1000
TRACKING_TTL_SECONDS=60 · WORKER_INLINE=false

URBANEBOLT_ENABLED · URBANEBOLT_BASE_URL · URBANEBOLT_USERNAME · URBANEBOLT_PASSWORD
URBANEBOLT_CUSTOMER_CODE · URBANEBOLT_TIMEOUT_MS · URBANEBOLT_RETRY_ATTEMPTS
URBANEBOLT_RETRY_BACKOFF_MS · URBANEBOLT_MAX_BATCH_SIZE=15

MOCK_ENABLED · MOCK_LATENCY_MS · MOCK_FAILURE_RATE · MOCK_FORCE_ERROR
```

Each courier descriptor carries its own zod config schema. The registry validates every enabled courier at boot and reports missing variables by name.

---

## 10. Proof

**Tests (Vitest).**
Unit — request mapper, status map (including the unmapped-code path), error classifier (200-with-`Failed`), each decorator in isolation, registry resolution, chunking logic.
Integration — the real Express app via supertest with nock intercepting UrbaneBolt: happy paths, `200`-with-`Failed`, `401` refresh-and-retry-once, timeout ⇒ backoff ⇒ `COURIER_TIMEOUT`, idempotent replay, bulk partial success end to end. Postgres via testcontainers so CI is self-contained.

**MockCourier** — a second real adapter proving the registry is pluggable, with env-driven knobs to force timeouts, 5xx, auth expiry, and per-item validation failures. Doubles as the demo vehicle.

**WireMock** — a compose service stubbing `uat.urbanebolt.in`. Proves base URLs are genuinely config-driven and lets the whole stack run offline with no credentials. Stubs cover auth (valid + expired), manifest (success / partial / 5xx / fixed-delay timeout), tracking, and cancel. Distinct from MockCourier: MockCourier is a fake _adapter_, WireMock is a fake _server_.

---

## 11. API documentation — one source of truth

zod schemas are already required for request validation, so everything else is derived from them
rather than hand-maintained:

```
zod schemas  (validation, already needed)
     │
     ├─ @asteasolutions/zod-to-openapi  ──►  OpenAPI 3.1 spec
     │                                          │
     │                                          ├─ swagger-ui-express  ──►  GET /docs
     │                                          ├─ GET /docs/openapi.json
     │                                          ├─ docs/openapi.json  (committed)
     │                                          └─ openapi-to-postmanv2  ──►  postman/*.json
```

`npm run docs:generate` writes the spec and regenerates the Postman collection. Nothing can drift,
because a schema change that breaks validation also changes the docs. Swagger UI is served in every
environment; hand-written curl examples still go in the README for anyone who would rather paste
than click.

## 12. Deliverables

`README.md` — setup, env vars, how to run, how to test, **how to add a new courier**.
`DESIGN.md` — architecture, patterns and why, schema, trade-offs, and the open items from §14.
`postman/multi-courier.postman_collection.json` — generated from the OpenAPI spec.
Swagger UI at `/docs`; `docs/openapi.json` committed.
`docker-compose.yml` — Postgres, Redis, WireMock, API, worker.
`.github/workflows/ci.yml` — lint, typecheck, test.
`scripts/demo.sh` — create → track → cancel → 100-order bulk with injected failures.

---

## 13. Build order

| Phase | Work                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------- |
| 0     | `git init`, scaffold, ESLint/Prettier/tsconfig, env config, logger, error envelope, request-id, `/health` |
| 1     | Drizzle schema + migrations + repositories                                                                |
| 2     | Courier core: interface, registry, three decorators, composition root                                     |
| 3     | UrbaneBolt adapter: client + token cache, mapper, status map, error classifier                            |
| 4     | Single-order endpoints: create, get, list, track, cancel, retry                                           |
| 5     | Bulk: queue, chunked worker, batch endpoints                                                              |
| 6     | MockCourier, WireMock stubs, docker-compose                                                               |
| 7     | Test suite                                                                                                |
| 8     | README, DESIGN.md, Postman, OpenAPI, CI, demo script                                                      |

Phases 0–5 are the critical path. If time runs short, 6–8 compress before anything in 0–5 is cut.

Each phase ends with a walkthrough — what was built, why that shape, what the alternative would have
cost — so a decision can be redirected while it is still cheap. The code stays comment-free; the
durable version of those explanations lands in `DESIGN.md`.

## 14. Known open items (to be stated plainly in DESIGN.md)

1. UrbaneBolt's full status code list is unpublished — only `MAN` and `CAN` are verified. The map is extensible and safe by default.
2. A duplicate `orderNumber` returns no AWB and there is no lookup-by-orderNumber endpoint, so a retried create that actually succeeded cannot be auto-reconciled. It is surfaced as `RECONCILIATION_REQUIRED` rather than silently guessed.
3. No circuit breaker. Retry + timeout only; noted as the natural next step.
4. Single-tenant. `order_id` uniqueness is global; a tenant column is the obvious extension.
5. Create does not pre-check serviceability — it costs a round trip and the courier validates anyway. The endpoint is exposed for callers who want the check.


---

## 15. Deviations taken during the build

Recorded here because the plan was written before the code existed. `DESIGN.md` carries the
reasoning that matters to a reviewer.

1. **`courier_api_logs` has no foreign key to `orders`.** It stores a text `reference` (business
   order id, or AWB for tracking and cancellation) instead. Authentication calls and chunked batch
   calls belong to no single order, and a nullable FK would have needed ambient request context to
   populate.
2. **No `loaders/` folder.** `container.ts` is the composition root and sequences startup on its
   own; a separate loaders layer would have been an empty abstraction.
3. **`src/integrations/`, not `src/couriers/`.** Renamed so it cannot be confused with
   `components/couriers`, which holds the contract and registry rather than any concrete courier.
4. **No synthetic tracking event on create.** `tracking_events` holds courier scans only. The order
   row already carries status and `created_at`; inventing a scan the courier never sent would
   pollute the history.
5. **`attempt` moved from `CourierAudit` to the request context.** The retry decorator sits outside
   the audit decorator, so the attempt number cannot be passed down the call chain.
6. **Courier wording is replaced, not just re-coded.** The first working build leaked
   `"Consignee Pincode 999999 is not serviceable"` straight to the client. `CourierError` now keeps
   the courier's text as `courierMessage` and answers with our own sentence.
