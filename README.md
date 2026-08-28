# Multi-Courier Integration Platform

One courier-agnostic API in front of many courier partners. Callers send a normalized payload with a
`courier_partner` field and never learn what the courier's own API looks like. UrbaneBolt is the
first real integration; MockCourier is a second adapter that exists to prove the plug-in design
works for something that is not UrbaneBolt.

- Architecture and trade-offs: [DESIGN.md](DESIGN.md)
- Coding conventions: [docs/CONVENTIONS.md](docs/CONVENTIONS.md)
- What the UrbaneBolt API actually does: [docs/urbanebolt-api-findings.md](docs/urbanebolt-api-findings.md)
- Interactive API docs: `http://localhost:3000/docs` once running

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npm run db:migrate
npm run dev
```

`npm run dev` starts the API. Add `WORKER_INLINE=true` to run the bulk queue worker in the same
process, or run `npm run dev:worker` in a second terminal to run it separately, as production does.

Then either open `http://localhost:3000/docs` or run the scripted walkthrough:

```bash
npm run demo                 # create, replay, track, cancel, bulk with failures
COURIER=urbanebolt npm run demo   # same walkthrough against the live UrbaneBolt UAT API
```

### Everything in containers

```bash
docker compose up --build
```

Brings up Postgres, Redis, WireMock, the migration job, the API and the worker.

### Running with no credentials and no internet

WireMock stands in for `uat.urbanebolt.in`, so the whole system is exercisable offline:

```bash
docker compose up -d wiremock
URBANEBOLT_BASE_URL=http://localhost:8080 npm run dev
```

Or bring up the whole stack that way in one step — this is exactly what CI runs:

```bash
cp .env.ci .env
docker compose up -d --build --wait
npx newman run postman/multi-courier.postman_collection.json
```

The stubs cover authentication, tracking, cancellation, pincode lookup, a 502 outage and a
30-second stall. The manifest stub reports per-item outcomes the way the real endpoint does, so a
bulk submission offline shows real partial success rather than all-or-nothing. An order whose `items[0].description` is `FORCE_OUTAGE` or `FORCE_TIMEOUT` triggers
the last two, which is how the retry and timeout paths are demonstrated without breaking anything
real.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `development` · `test` · `production` |
| `LOG_LEVEL` | `info` | pino level, `silent` included |
| `LOG_PRETTY` | `false` | Human-readable logs in development |
| `API_KEY` | unset | When set, every `/api/v1` route requires `X-API-Key`. `/health` and `/docs` stay open |
| `DEBUG_COURIER_ERRORS` | `false` | Appends the courier's own wording to error responses. Never enable in production |
| `REQUEST_BODY_LIMIT` | `4mb` | Body-parser limit. A bulk request carries up to 100 orders, so this has to clear that with room |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | How long SIGTERM waits for in-flight work before the process exits anyway |
| `DATABASE_URL` | — | **Required.** Postgres connection string |
| `REDIS_URL` | — | **Required.** Redis connection string for BullMQ |
| `BULK_MAX_ORDERS` | `100` | Largest accepted bulk request |
| `BULK_WORKER_CONCURRENCY` | `5` | Chunks processed in parallel |
| `BULK_JOB_ATTEMPTS` | `3` | Attempts per chunk before it is abandoned |
| `BULK_BACKOFF_MS` | `1000` | Base delay for the queue's exponential backoff |
| `BULK_STALL_CHECK_MS` | `15000` | How often the supervisor checks whether the worker is still consuming |
| `TRACKING_TTL_SECONDS` | `60` | Serve tracking from the database within this window instead of calling the courier. `0` disables |
| `WORKER_INLINE` | `false` | Run the queue worker inside the API process |

Per courier, by naming convention — a new courier picks these up for free:

| Variable | Default | Purpose |
|---|---|---|
| `URBANEBOLT_ENABLED` | `true` | Set to `false` to unregister the courier |
| `URBANEBOLT_BASE_URL` | — | Point at WireMock to run offline |
| `URBANEBOLT_USERNAME` / `_PASSWORD` | — | UAT credentials, published in UrbaneBolt's own docs |
| `URBANEBOLT_CUSTOMER_CODE` | — | Account code. Config, never part of the API contract |
| `URBANEBOLT_TIMEOUT_MS` | `15000` | Per-request timeout |
| `URBANEBOLT_RETRY_ATTEMPTS` | `3` | Attempts on transport failure |
| `URBANEBOLT_RETRY_BACKOFF_MS` | `500` | Base backoff delay |
| `URBANEBOLT_MAX_BATCH_SIZE` | `15` | Orders per native manifest call |
| `MOCK_ENABLED` | `false` | Register MockCourier |
| `MOCK_LATENCY_MS` / `MOCK_FAILURE_RATE` | `0` / `0` | Simulated latency and random failure rate |
| `MOCK_FORCE_ERROR` | `none` | `timeout` · `unavailable` · `auth` · `validation` |

Nothing is hardcoded. A missing or malformed variable stops the process at boot and names the
variable rather than failing on the first order.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/orders` | Create a shipment. `201` when created, `200` with `idempotent_replay: true` on a repeat |
| `GET` | `/api/v1/orders` | Filter by `status` and `courier_partner`; used for reconciliation |
| `GET` | `/api/v1/orders/{order_id}` | Read one order |
| `GET` | `/api/v1/orders/{order_id}/track` | Live courier call, TTL-guarded, appends new scans |
| `POST` | `/api/v1/orders/{order_id}/cancel` | Cancel before pickup |
| `POST` | `/api/v1/orders/{order_id}/retry` | Re-drive a failed order |
| `POST` | `/api/v1/orders/bulk` | Up to 100 orders. Returns `202` with a `batch_id` |
| `GET` | `/api/v1/batches/{batch_id}` | Per-order outcomes for a bulk submission |
| `GET` | `/api/v1/couriers` | Supported couriers and their capabilities |
| `GET` | `/api/v1/serviceability` | `?courier_partner=&pincodes=122001,122017` |
| `GET` | `/health` | Liveness. Answers whenever the process is up; never touches a dependency |
| `GET` | `/health/ready` | Readiness. Probes Postgres, Redis and the courier registry. `503` when any is down |
| `GET` | `/docs` · `/docs/openapi.json` | Swagger UI and the raw OpenAPI document |

### Postman

[postman/multi-courier.postman_collection.json](postman/multi-courier.postman_collection.json) and
[docs/openapi.json](docs/openapi.json) are both generated from the zod schemas that validate the
requests, so they cannot drift from the code. Run `npm run docs:generate` after changing a schema.

Import it and it runs top to bottom with no editing: every request body is a real payload rather
than a generated one, and a test script on the collection carries `order_id` and `batch_id` from
each response into the next request. Four collection variables are the only knobs — `baseUrl`,
`apiKey` (leave empty unless `API_KEY` is set), `orderId` and `batchId`.

```bash
npx newman run postman/multi-courier.postman_collection.json
```

Swagger UI is driven by the same document: the server URL is an editable variable, and **Authorize**
sets `X-API-Key` for the routes that require it.

### Creating an order

```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "courier_partner": "urbanebolt",
    "order_id": "ORD-1001",
    "payment_mode": "COD",
    "service_level": "SAME_DAY",
    "collectable_amount": 1499,
    "declared_value": 1499,
    "invoice": { "number": "INV-1", "date": "2026-08-27", "value": 1499 },
    "pickup":   { "name": "Warehouse", "phone": "9425018023", "line1": "Plot 137 Sector-I",
                  "city": "Gurgaon", "state": "Haryana", "pincode": "122017",
                  "country": "INDIA", "type": "SELLER" },
    "delivery": { "name": "Priya Sharma", "phone": "8320226438", "line1": "26 Om Nagar",
                  "city": "Gurgaon", "state": "Haryana", "pincode": "122001",
                  "country": "INDIA", "type": "HOME" },
    "package":  { "weight_kg": 1.1, "length_cm": 12, "breadth_cm": 10, "height_cm": 10, "pieces": 1 },
    "items":    [{ "description": "Paperback books", "quantity": 1 }]
  }'
```

Nothing in that payload is UrbaneBolt-shaped. `SAME_DAY` becomes `SDD`, `COD` stays `COD`, the three
addresses become `shpr`/`rtn`/`cons`, and `customerCode` comes from configuration — all inside the
adapter.

### Error shape

Every endpoint, success or failure, answers with the same envelope.

```jsonc
{ "success": true, "data": { … }, "request_id": "req_01J…" }

{ "success": false,
  "error": {
    "code": "PINCODE_NOT_SERVICEABLE",
    "message": "The delivery pincode is not serviceable by this courier",
    "details": [],
    "courier_partner": "urbanebolt",
    "retryable": false },
  "request_id": "req_01J…" }
```

`message` is always our wording. The courier's own text is persisted on the order and in
`courier_api_logs`, and logged with the request id — it never reaches a caller.

### Health probes

`/health` is liveness — it answers as long as the process is up and deliberately touches nothing, so
a database blip cannot make an orchestrator kill an otherwise healthy container.

`/health/ready` is readiness. It probes Postgres, Redis and the courier registry in parallel, each
with a 2-second bound, and reports every one:

```bash
curl -s localhost:3000/health/ready | jq .data
{
  "status": "ready",
  "version": "1.0.0",
  "uptime_seconds": 42,
  "checks": [
    { "name": "postgres", "status": "up", "duration_ms": 3 },
    { "name": "redis",    "status": "up", "duration_ms": 1, "detail": "PONG" },
    { "name": "couriers", "status": "up", "duration_ms": 0, "detail": "mock, urbanebolt" }
  ]
}
```

With a dependency down it returns `503` and names it, while `/health` stays `200`:

```json
{ "status": "degraded",
  "checks": [
    { "name": "postgres", "status": "up",   "duration_ms": 2 },
    { "name": "redis",    "status": "down", "error": "probe did not answer within 2000ms" },
    { "name": "couriers", "status": "up",   "detail": "mock, urbanebolt" }
  ] }
```

Both probes and `/docs` stay reachable when `API_KEY` is set.

Send `X-Request-Id` and it is echoed back and attached to every log line for that request; omit it
and one is generated.

## Testing

```bash
npm test               # unit: mappers, status map, error classifier, decorators, HTTP pipeline
npm run test:int       # integration: real Express + Postgres + Redis, courier stubbed with nock
npm run test:all
npm run test:coverage  # both suites, coverage to coverage/
npm run verify         # lint + format check + typecheck + unit tests, the same gate CI runs first
```

Integration tests start Postgres and Redis with testcontainers by default. Locally, reusing the
compose services is faster:

```bash
docker compose up -d postgres redis
docker compose exec postgres psql -U postgres -c 'CREATE DATABASE courier_test;'
npm run test:int:local
```

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs five jobs on every push and pull request:

| Job | What it does |
|---|---|
| `static` | lint, `prettier --check`, typecheck, build, and an audit of runtime dependencies |
| `generated` | regenerates `docs/openapi.json`, the Postman collection and the SQL migrations, and fails if any of them differ from what is committed |
| `test` | the full suite against Postgres and Redis services, with a coverage summary on the run |
| `e2e` | `docker compose up` with WireMock standing in for UrbaneBolt, then the Postman collection through newman |
| `image` | builds the Docker image on every PR; publishes it to GHCR from `main` |

If `generated` fails, run `npm run docs:generate && npm run db:generate` and commit the result.
Generation is deterministic, so a diff there is always a real change.

## Adding a new courier

Requirement 3.2 says adding a courier must not touch controllers, routes, unified DTOs, existing
adapters, or business logic. It does not.

1. Create `src/integrations/<courier>/` and implement `CourierAdapter`:

   ```
   <courier>.adapter.ts      orchestrates a call
   <courier>.client.ts       HTTP and credentials
   <courier>.mapper.ts       NormalizedOrder to their payload
   <courier>.status-map.ts   their scan codes to ours
   <courier>.errors.ts       decides what "failed" means for them
   <courier>.config.ts       zod schema for their env vars
   index.ts                  exports a CourierDescriptor
   ```

2. Declare what it can do:

   ```ts
   readonly capabilities = {
     supportsBatchCreate: false,
     maxBatchSize: 1,
     supportsCancel: true,
     supportsServiceability: false,
   };
   ```

   The bulk worker reads this. A courier with a native batch endpoint gets chunked calls; one
   without gets a call per order. Neither the worker nor any service learns the courier's name.

3. Add one import line to `src/integrations/index.ts`.

4. Set `<COURIER>_ENABLED=true` and its config variables. Retry configuration
   (`<COURIER>_RETRY_ATTEMPTS`, `_RETRY_BACKOFF_MS`, `_RETRY_MAX_BACKOFF_MS`) is picked up by naming
   convention.

Retry with backoff, re-authentication, and audit logging are applied by the decorator chain in
`src/container.ts` — a new courier inherits all three without implementing any of them. `MockCourier`
is a working example, deliberately kept small.

## Layout

```
src/components/orders      entry-points/{api,queue} · domain · data-access
src/components/couriers    the contract, registry and decorators — no concrete courier
src/integrations           concrete adapters: urbanebolt/ · mock/
src/libraries              config · logger · errors · http · openapi · queue
src/container.ts           the composition root: the whole object graph on one screen
```

Components talk to each other through their `index.ts` only; a lint rule fails the build on a deep
import across that boundary.
