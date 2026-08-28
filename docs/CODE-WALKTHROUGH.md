# Code walkthrough

This is the long-form explanation of the codebase: what each piece does, why it is shaped that way,
and what would have gone wrong under the alternatives. [DESIGN.md](../DESIGN.md) is the summary for
a reviewer in a hurry; this document is for someone who wants to be able to change the code.

Read it in order the first time. Sections 1–4 explain the shape, 5–9 walk through the parts that do
real work, 10–15 cover the cross-cutting concerns, 16 is a list of decisions with the option that
was rejected, and 17 indexes the design patterns against what each one is buying.

---

## 1. What the system has to do, restated

A caller wants to ship a parcel. They should not care which courier does it. So:

```
POST /api/v1/orders  { "courier_partner": "urbanebolt", "order_id": "ORD-1001", ... }
```

One request shape, one response shape, N couriers behind it. That single sentence generates almost
every design decision in this repo, because it means **nothing outside `src/integrations/` may know
that UrbaneBolt exists**. Not the controller, not the service, not the DTOs, not the queue worker,
not the database schema.

The forces that make this hard are not the mapping — mapping one JSON shape to another is easy. They
are:

- Couriers disagree about what "an error" is. UrbaneBolt answers `HTTP 200` with `{"status":"Failed"}`.
- Couriers disagree about batching. UrbaneBolt's create endpoint is natively an array; MockCourier
  takes one order at a time.
- Couriers disagree about authentication. UrbaneBolt hands out a 24h bearer token.
- Retry, re-authentication and audit logging are needed for *every* courier, so they must live in one
  place — but that one place must not contain a single courier-specific `if`.

Sections 6 and 7 are about exactly those four problems.

---

## 2. The layers, and the rule that keeps them honest

```
src/
  components/
    orders/            the business capability: creating, tracking, cancelling, bulk
      entry-points/    api/ (Express) · queue/ (BullMQ) — how the outside world gets in
      domain/          services, the presenter — the actual rules
      data-access/     repositories and the Drizzle schema — the only place SQL happens
    couriers/          the courier *contract*, the registry, the decorators — no concrete courier
      domain/          CourierAdapter, CourierRegistry, decorators, shared vocabulary
      data-access/     courier_api_logs
      entry-points/api /couriers and /serviceability
  integrations/        the concrete couriers: urbanebolt/ · mock/
  libraries/           config · logger · errors · http · openapi · queue · context
  container.ts         the composition root
  app.ts               Express wiring
  server.ts            HTTP entry point
  worker.ts            queue entry point
```

This is component-based rather than layer-based. A layer-based tree (`controllers/`, `services/`,
`models/`) spreads one feature across three folders and tells you nothing about what the system
*does*. Here, everything about orders is under `components/orders`, and the top-level tree reads as
a description of the product.

Inside each component there are three layers, and the dependency direction is one-way:

```
entry-points  →  domain  →  data-access
```

`domain` never imports Express. That is what lets the queue worker and the HTTP controller share
`BulkOrderService` unchanged — the service has no idea which of them called it.

**The rule is enforced, not documented.** `eslint.config.js`:

```js
const noConcreteCouriers = {
  group: ['**/integrations/**'],
  message: 'Concrete couriers may only be referenced from src/integrations and the composition root.
            Depend on the CourierAdapter contract instead.',
};
```

That pattern is applied to `src/components/**` and `src/libraries/**`. If anyone ever writes
`import { UrbaneBoltAdapter } from '../../integrations/urbanebolt'` inside a service, the build
fails. There is a second rule that stops components reaching into each other's internals — orders
may import `components/couriers`, but only through its `index.ts`, never a deep path.

The reason to spend a lint rule on this: architecture documents rot silently, lint rules do not.

---

## 3. The composition root

`src/container.ts` builds every object in the system, in one function, in dependency order. There is
no DI framework and no decorators-with-metadata.

```ts
const { db, pool } = createDatabase(config.databaseUrl, logger);
const orders = new OrderRepository(db);
const trackingEvents = new TrackingEventRepository(db);
const batches = new BulkBatchRepository(db);
const courierLogs = new CourierApiLogRepository(db);

const registry = buildRegistry(COURIER_DESCRIPTORS, env, { logger }, (adapter) => {
  const audited = new AuditLoggingCourierAdapter(adapter, courierLogs, logger);
  const reauthenticating = new AuthRefreshingCourierAdapter(audited, logger);
  return new RetryingCourierAdapter(reauthenticating, retryOptionsFor(adapter.id, env), logger);
});
```

Everything is constructor-injected, so every class can be tested by handing it fakes, and the whole
object graph fits on one screen. A container library would buy runtime magic in exchange for a
question — "where does this instance come from?" — that this file answers by being readable.

Note `retryOptionsFor(adapter.id, env)`. Retry configuration is derived from the courier id by
naming convention:

```ts
const prefix = courierId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
attempts: positiveInt(env[`${prefix}_RETRY_ATTEMPTS`], 3),
```

So a new courier called `delhivery` picks up `DELHIVERY_RETRY_ATTEMPTS` without anyone editing the
container. This is the difference between "adding a courier requires a code change here" and "adding
a courier requires no change here", which is requirement 3.2.

---

## 4. One request, end to end

`POST /api/v1/orders` with a valid body, UrbaneBolt selected. Every hop:

| # | Where | What happens |
|---|---|---|
| 1 | `libraries/http/middleware/request-id.ts` | Reads `X-Request-Id` or generates one, and opens an `AsyncLocalStorage` scope for the request |
| 2 | `libraries/http/middleware/access-log.ts` | `pino-http` starts the access record; it is written when the response finishes |
| 3 | `express.json()` + `libraries/http/middleware/body-errors.ts` | Parses the body, and turns a parse or size failure into a real `400`/`413` instead of letting it escape as a `500` |
| 4 | `libraries/http/middleware/api-key.ts` | If `API_KEY` is configured, compares `X-API-Key` in constant time; otherwise waves it through |
| 5 | `orders.routes.ts` | Matches the route |
| 6 | `orders.schemas.ts` via `libraries/http/validate.ts` | `createOrderSchema.parse` — strict, so an unknown field is a 400, not a silent drop |
| 7 | `toNormalizedOrder()` | snake_case DTO → camelCase `NormalizedOrder` domain type |
| 8 | `OrderService.create()` | Business rules |
| 9 | `OrderRepository.insertPending()` | `INSERT ... ON CONFLICT (order_id) DO NOTHING RETURNING *` — this is the idempotency mechanism |
| 10 | `RetryingCourierAdapter` → `AuthRefreshingCourierAdapter` → `AuditLoggingCourierAdapter` → `UrbaneBoltAdapter` | The decorator chain |
| 11 | `urbanebolt.mapper.ts` | `NormalizedOrder` → UrbaneBolt's manifest item |
| 12 | `urbanebolt.client.ts` | Token (cached), `fetch`, timeout, audit entry appended |
| 13 | `urbanebolt.errors.ts` | Decides whether that HTTP 200 was actually a failure |
| 14 | `OrderRepository.markShipmentCreated()` | AWB, label, status, plus the raw request/response |
| 15 | `order.presenter.ts` | Row → response body |
| 16 | `libraries/http/envelope.ts` | Wraps it: `{ success, data, request_id }` |

**The order of steps 1 to 3 is load-bearing.** The request id is assigned *before* the body parser
runs, because a body that fails to parse is exactly the response somebody will bring back asking what
happened. With the parser first, every malformed-JSON response came back carrying
`"request_id": "unknown"` and nothing in the logs to join it to.

Three things in that list carry more weight than they look.

**Step 9 is the idempotency design.** The order row is written *before* the courier is called, using
the caller's `order_id` as a unique key. The insert tells us whether the row already existed:

```ts
const { order, alreadyExisted } = await this.reserve(input);

// A PENDING row that already existed means an earlier attempt died before the courier
// answered. Re-driving it is safe; anything further along is a genuine replay.
if (alreadyExisted && order.status !== ShipmentStatus.PENDING) {
  return { order, idempotentReplay: true };
}
```

That distinction matters. If the row exists and is `CREATED`, a second identical request is a replay
and gets `200` with the original AWB. If the row exists but is still `PENDING`, the previous attempt
died mid-flight and re-driving is the correct recovery. Doing the insert *after* the courier call
would leave no trace of that crashed attempt at all.

**Step 10 is the whole architecture in one line.** Section 6.

---

## 5. The courier contract

`components/couriers/domain/courier.interface.ts` is the seam the entire system pivots on.

```ts
export interface CourierAdapter {
  readonly id: string;
  readonly capabilities: CourierCapabilities;

  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>>;
  createShipments?(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>>;
  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>>;
  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>>;
  checkServiceability?(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>>;

  isAuthFailure(error: unknown): boolean;
  invalidateAuth(): Promise<void>;
}
```

Four things to notice.

**Optional methods plus a capabilities object.** `createShipments?` and `checkServiceability?` are
optional because not every courier has them. But optional methods alone are not enough — a caller
would have to probe for a method to decide how to behave, which is awkward and untypeable. So
capability is *declared*:

```ts
export type CourierCapabilities = {
  readonly supportsBatchCreate: boolean;
  readonly maxBatchSize: number;
  readonly supportsCancel: boolean;
  readonly supportsServiceability: boolean;
};
```

The bulk worker reads `maxBatchSize` to decide how big a chunk is, and `supportsBatchCreate` to
decide whether to call the batch method at all. It never learns a courier name:

```ts
const batchCreate = adapter.createShipments?.bind(adapter);
if (adapter.capabilities.supportsBatchCreate && batchCreate !== undefined && rows.length > 1) {
  await this.runNativeBatch(job.batchId, adapter, rows, batchCreate);
} else {
  await this.runOneByOne(job.batchId, adapter, rows);
}
```

MockCourier declares `supportsBatchCreate: false, maxBatchSize: 1` and automatically gets the
one-by-one path. No `if (courier === 'urbanebolt')` anywhere.

**Every method returns `CourierResult<T>`, not `T`:**

```ts
export type CourierResult<T> = { value: T; audit: CourierAudit[] };
```

The `audit` array is a list of the actual HTTP calls made — URL, request body, status, response
body, duration. This is what lets the audit decorator persist a complete record *without knowing how
the adapter talks to anyone*. A courier that needs three HTTP calls to create one shipment returns
three audit entries and the decorator writes three rows.

**`isAuthFailure` and `invalidateAuth` are the auth seam.** More in section 6.

**`CourierDescriptor` is the registration seam:**

```ts
export type CourierDescriptor = {
  readonly id: string;
  readonly displayName: string;
  isEnabled(env: NodeJS.ProcessEnv): boolean;
  create(env: NodeJS.ProcessEnv, deps: CourierFactoryDependencies): CourierAdapter;
};
```

A descriptor knows how to decide whether it is switched on and how to build itself from environment
variables. `src/integrations/index.ts` is a one-line-per-courier barrel, and `buildRegistry` walks
it. Adding a courier is: new folder, export a descriptor, add one import line.

---

## 6. The decorator chain

Retry, re-authentication and audit logging are needed by every courier. Three obvious places to put
them, two of which are wrong:

- *In each adapter* — duplicated N times, and every new courier reimplements them slightly wrong.
- *In the service* — the service starts knowing about HTTP, tokens and transport failures, which are
  not business concepts.
- *Wrapped around the adapter* — the adapter stays a pure translation layer, the service stays pure
  business logic, and the cross-cutting concerns live in one place each. This is what the code does.

Because each decorator implements `CourierAdapter` and holds a `CourierAdapter`, they compose in any
order and nothing downstream can tell it is talking to a decorator.

The order is chosen, not incidental:

```
RetryingCourierAdapter
└── AuthRefreshingCourierAdapter
    └── AuditLoggingCourierAdapter
        └── UrbaneBoltAdapter
```

**Audit innermost** so that one HTTP attempt produces one audit row. If audit were outermost, three
retries would collapse into a single row and the record of what actually happened on the wire would
be lost.

**Auth-refresh inside retry** so an expired token does not consume a transport retry. A dead token
is not a transport problem; it should cost one re-auth and one replay, not one of the three attempts
reserved for genuine network trouble.

### How retry stays courier-agnostic

The retry decorator contains no knowledge of any courier. It obeys a flag:

```ts
// The adapter decides what is retryable, because only it knows that an UrbaneBolt 200 carrying
// status "Failed" is a permanent business error while a 502 is not.
const retryable = isAppError(error) && error.retryable;
if (!retryable || attempt === this.options.attempts) {
  throw error;
}
```

The adapter sets `retryable` when it raises the error. In `urbanebolt.errors.ts`, `businessError()`
sets `retryable: false` and `transportError()` sets `retryable: true`. So the classification lives
with the courier that needs it and the generic machinery just reads a boolean.

Backoff is exponential with jitter and a ceiling:

```ts
const exponential = this.options.backoffMs * 2 ** (attempt - 1);
const capped = Math.min(exponential, this.options.maxBackoffMs);
return Math.round(capped * (0.5 + Math.random() * 0.5));
```

The jitter matters: without it, a courier outage that fails 50 concurrent bulk chunks would have all
50 retry at the same instant and hammer the courier the moment it recovers.

### How re-authentication stays courier-agnostic

```ts
try {
  return await call();
} catch (error) {
  if (!this.inner.isAuthFailure(error)) {
    throw error;
  }
  await this.inner.invalidateAuth();
  return await call();   // exactly once
}
```

The decorator does not know what an auth failure looks like — it *asks*. UrbaneBolt signals a dead
token with a real `401` **and a different body shape** (`{"detail": ...}`) from every other error, so
`UrbaneBoltAdapter.isAuthFailure` answers on its own terms. A courier that signalled auth failure
with an HTTP 200 and an error code in the body would answer differently, and this decorator would
not change.

Retry-once-only is deliberate. If re-authentication does not fix it, the credentials are wrong and
looping would just lock the account.

### How audit stays courier-agnostic

It reads the `audit` array off the result — or, on failure, off the error:

```ts
try {
  const result = await call();
  await this.persist(result.audit, reference, null);
  return result;
} catch (error) {
  await this.persist(auditOf(error), reference, isAppError(error) ? error.code : null);
  throw error;
}
```

`auditOf(error)` returns the audit entries when the error is a `CourierError` and an empty array
otherwise. This is why the audit trail survives failures, which is the case you actually need it
for.

One deliberate asymmetry:

```ts
} catch (error) {
  // Losing an audit row must never fail the shipment it describes, so this is logged and
  // dropped rather than rethrown.
  this.logger.error({ err: error, courier: this.inner.id, reference }, 'Failed to persist courier audit log');
}
```

If Postgres is briefly unavailable while an audit row is being written, the shipment — which the
courier has already accepted — must not fail because of bookkeeping.

---

## 7. Inside the UrbaneBolt adapter

Six files, each with one job. That split is what makes the adapter reviewable; a single
`urbanebolt.ts` of 600 lines would not be.

| File | Responsibility |
|---|---|
| `urbanebolt.config.ts` | zod schema for `URBANEBOLT_*` env vars |
| `urbanebolt.client.ts` | HTTP, token caching, timeouts, audit entries, transport errors |
| `urbanebolt.mapper.ts` | `NormalizedOrder` → their manifest item |
| `urbanebolt.status-map.ts` | Their scan codes → our `ShipmentStatus`, and their timestamps → `Date` |
| `urbanebolt.errors.ts` | What counts as a failure, and which of our codes it is |
| `urbanebolt.adapter.ts` | Orchestrates the above and satisfies `CourierAdapter` |
| `urbanebolt.schemas.ts` | zod schemas for their *responses* — the API is not trusted to keep its shape |

### The 200-is-not-success problem

This is the single most important fact about this courier, verified by calling the UAT API (see
[urbanebolt-api-findings.md](urbanebolt-api-findings.md)):

```
POST /api/v1/services/manifest/  →  HTTP 200
{ "status": "Success",
  "successResponse": [],
  "errorResponse": [ { "orderNumber": "ORD-1", "message": "Consignee Pincode 999999 is not serviceable" } ] }
```

A naive `if (response.ok)` would record that as a successful shipment with no AWB. So classification
is centralised in one file with a comment saying so:

```ts
// UrbaneBolt answers 200 OK for business failures. A bad pincode, a duplicate order number and a
// validation error all arrive as HTTP 200 with `status: "Failed"` or a populated errorResponse[].
// The only genuine HTTP status it uses for a semantic problem is 401 for a dead token, and that
// response has a different body shape again ({"detail": ...}). Everything downstream of this file
// gets to assume a thrown CourierError means failure and a returned value means success.
```

That last sentence is the contract. `urbanebolt.errors.ts` is the only file in the repo that knows
this courier's failure conventions.

Message-to-code classification is string matching, because that is all the API offers:

```ts
if (text.includes('not serviceable')) return ErrorCode.PINCODE_NOT_SERVICEABLE;
if (text.includes('already shipped'))  return ErrorCode.DUPLICATE_AT_COURIER;
if (text.includes('already cancelled')) return ErrorCode.SHIPMENT_ALREADY_CANCELLED;
...
return ErrorCode.COURIER_VALIDATION_ERROR;   // the safe default
```

Fragile, and knowingly so — it is isolated in one function with unit tests, and the fallback is a
correct-if-vague code rather than a wrong specific one.

### Single create is batch create

UrbaneBolt has no single-shipment endpoint. Rather than pretend otherwise:

```ts
// UrbaneBolt has no single-shipment endpoint. A one-order manifest is the single-order path.
async createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>> {
  const result = await this.createShipments([order]);
  const outcome = result.value[0];
  ...
}
```

One code path, so the single-order case cannot drift from the bulk case.

### The timestamp bug that would have shipped silently

UrbaneBolt returns `"27 Aug 2026, 17:34"` with no timezone. `new Date("27 Aug 2026, 17:34")` parses
in the *server's* local zone. On a laptop in India that is right by accident; in a UTC container it
is wrong by five and a half hours, and every tracking event lands in the wrong place — with no error
anywhere.

```ts
const IST_OFFSET_MINUTES = 330;
const TIMESTAMP = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?$/;

// UrbaneBolt returns "27 Aug 2026, 17:34" with no timezone. Date.parse would read it in the
// server's local zone, which silently shifts every tracking event once deployed outside IST.
export function parseUrbaneBoltTimestamp(value: string): Date | null { ... }
```

It returns `null` rather than throwing, and the adapter drops that scan with a warning:

```ts
// Storing an unparseable timestamp would break the dedup key that makes tracking history
// append-only, so the scan is dropped here and stays recoverable from courier_api_logs.
```

The event time is part of the uniqueness constraint on `tracking_events`, so a garbage timestamp
would corrupt deduplication for that shipment forever. Dropping is the conservative choice, and the
raw scan is still in the audit table.

### Unmapped status codes

UrbaneBolt does not publish its full scan-code list. Only `MAN` and `CAN` were confirmed live:

```ts
// Only MAN and CAN are confirmed against the live UAT API. UrbaneBolt does not publish its full
// scan-code list, so the rest are best-effort and anything unrecognised falls through to UNKNOWN
// rather than being forced into a wrong bucket.
```

`toShipmentStatus` falls back to `UNKNOWN` and the adapter logs a warning naming the code. A wrong
status is worse than an honest `UNKNOWN`, and the warning is how the map gets completed in
production rather than by guessing now.

---

## 8. Errors

Two class hierarchies, and one rule: **only `Error` subclasses are ever thrown**.

```
Error
└── AppError            code, status, details, courierPartner, retryable, isOperational
    └── CourierError    + courierMessage, + audit[]
```

### Operational vs programmer errors

`AppError` carries `isOperational`. An operational error is an expected condition — a bad pincode, a
courier timeout, a missing order. A programmer error is a bug — an undefined property, a failed
invariant. The distinction drives what the process does:

- Operational → answer the client with the mapped status, log at `warn`, keep serving.
- Programmer → answer `500` with a generic message, log at `error` with the stack, and (on an
  uncaught throw) exit so the supervisor can restart into a known-good state.

Anything thrown that is not an `AppError` is normalized to `INTERNAL_ERROR` with
`isOperational: false`, because an unrecognised throwable is by definition not an expected condition.

One `ErrorHandler` is shared by the Express middleware and the BullMQ failure handler, so a failure
is logged identically whether it happened in a request or in a background job.

### Error codes and HTTP status

`libraries/errors/error-codes.ts` holds the vocabulary and the mapping in one table:

```ts
const httpStatusByCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  MALFORMED_JSON: 400,
  UNKNOWN_COURIER_PARTNER: 400,
  UNAUTHORIZED: 401,
  ORDER_NOT_FOUND: 404,
  DUPLICATE_AT_COURIER: 409,
  RECONCILIATION_REQUIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  COURIER_VALIDATION_ERROR: 422,
  PINCODE_NOT_SERVICEABLE: 422,
  COURIER_RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  COURIER_AUTH_ERROR: 502,
  COURIER_UNAVAILABLE: 502,
  COURIER_NOT_CONFIGURED: 503,
  COURIER_TIMEOUT: 504,
};
```

`Record<ErrorCode, number>` rather than `Partial<...>`, so adding a code without a status is a
compile error.

The last three arrived by measurement rather than design. `express.json()` signals a rejected body by
throwing, and its error is an ordinary `Error` carrying a `type` string that nothing here understood.
A client sending a stray comma therefore got `500 INTERNAL_ERROR`, logged at error level as a
programmer fault — a caller's typo paging whoever is on call. `libraries/http/middleware/body-errors.ts`
translates the four types `express.json()` can raise, and sits directly after the parser rather than
inside the generic handler so that knowledge stays next to the thing that produces it.

The codes are chosen to be honest about *whose* fault a failure is. `COURIER_UNAVAILABLE` is `502`,
not `500`: our service is fine, our upstream is not. `COURIER_TIMEOUT` is `504`. A caller can write
a retry policy off the status code alone.

### Not leaking the courier's wording — and why it is enforced by the compiler

Requirement 3.5 says a courier's raw error must not reach our callers. Their text can contain
internal field names, account codes or customer data, and it ties our API's contract to their
phrasing.

The mechanism is a map of our sentences:

```ts
// Requirement 3.5 forbids leaking a courier's own wording to our callers. Any code listed here
// answers with our sentence instead; the courier's text is still persisted and logged. A
// CourierError may only carry a code from this map, so the substitution can never silently miss.
const clientMessages = {
  PINCODE_NOT_SERVICEABLE: 'The delivery pincode is not serviceable by this courier',
  DUPLICATE_AT_COURIER: 'The courier already holds a shipment for this order',
  ...
} as const satisfies Partial<Record<ErrorCode, string>>;

export type ClientFacingErrorCode = keyof typeof clientMessages;
```

`CourierError` then keeps both texts, and its constructor is typed so the substitution cannot fail:

```ts
// courierMessage is whatever the courier said. `message` is our normalized wording, so the
// envelope can never leak the courier's phrasing while the original stays available for logs,
// the audit trail and the failure recorded on the order. The narrowed code type is what
// guarantees our wording exists: a code with no client message will not compile here.
constructor(code: ClientFacingErrorCode, courierMessage: string, options: CourierErrorOptions = {}) {
  super(code, clientMessageFor(code), options);
  this.courierMessage = courierMessage;
}
```

Earlier this was `clientMessageFor(code) ?? courierMessage` — a fallback that would silently leak
the day someone raised a `CourierError` with a code that had no entry. Narrowing the parameter type
turned that runtime risk into a compile error, and doing so immediately surfaced a real hole:
`codeForMessage()` in `urbanebolt.errors.ts` was typed as returning the *whole* `ErrorCode` union,
so nothing stopped it returning `VALIDATION_ERROR`. It now returns `ClientFacingErrorCode`.

The same substitution is applied on the read paths, which is a separate leak that only turned up
when the Postman collection was actually run against the API. `GET /orders/{id}` was returning the
persisted courier text verbatim:

```ts
// A failure raised by an adapter is stored with the courier's own wording, which requirement 3.5
// forbids returning. Every code an adapter can raise has an entry in clientMessages, so a hit there
// means "replace this text"; a miss means the message was ours to begin with and can go out as is.
export function presentFailure(code: string | null, storedMessage: string | null) { ... }
```

The "miss means it was ours" reasoning is only valid because the set of codes an adapter can raise
is exactly the set with client messages — which is now a compile-time property, not a convention.

`DEBUG_COURIER_ERRORS=true` appends the courier's wording to error responses for local debugging.
It is off by default and the README says never to enable it in production.

### The response envelope

Every response, success or failure, has the same shape:

```jsonc
{ "success": true, "data": { ... }, "request_id": "req_01J..." }

{ "success": false,
  "error": { "code": "PINCODE_NOT_SERVICEABLE",
             "message": "The delivery pincode is not serviceable by this courier",
             "details": [],
             "courier_partner": "urbanebolt",
             "retryable": false },
  "request_id": "req_01J..." }
```

`retryable` is on the wire deliberately: a caller should not have to guess from a status code whether
resubmitting is sensible.

---

## 9. Persistence

Four tables. The schema is in `components/orders/data-access/schema.ts` and
`components/couriers/data-access/schema.ts` — each component owns its own tables.

**`orders`** — one row per `order_id`, unique. Holds the normalized payload, the courier's AWB, the
status, and both the raw request and raw response of the create call. The unique constraint *is* the
idempotency mechanism (section 4).

**`tracking_events`** — append-only history. The interesting part is this constraint:

```ts
// The courier returns its full scan list on every poll. This is what makes re-reading it
// append-only instead of duplicating history.
unique('tracking_events_unique_scan').on(table.orderId, table.courierStatusCode, table.eventTime),
```

Couriers return the *entire* scan list on every tracking call, not just what is new. Without a
dedup key, polling every 30 seconds would multiply history by the number of polls. With it, the
repository can insert everything it received and let the database discard what it already has —
which is also concurrency-safe in a way that a read-then-compare would not be.

**`bulk_batches` / `bulk_batch_items`** — one row per submitted order with its own status, AWB and
error. This is what makes partial success reportable per order rather than as a single batch verdict.
`unique(batchId, orderId)` keeps a retried job idempotent.

**`courier_api_logs`** — every HTTP call to a courier: operation, URL, request body, status, response
body, duration, request id, attempt number. This is the audit trail required by 4.2, and the reason
the create request/response is *also* denormalized onto the order row is that answering "what did we
send for this order" should not require a join and a scan.

The audit table deliberately has **no foreign key to `orders`**. Some calls (authentication,
serviceability) do not belong to an order at all, and an audit trail that can fail to write because
its parent row is missing is not an audit trail.

---

## 10. Bulk creation

Requirement: up to 100 orders, processed concurrently, partial success, idempotent on `order_id`.

### Why a queue

Doing 100 courier calls inside the request would mean a request that takes minutes, a client
timeout that loses all knowledge of what succeeded, and no retry story. So `POST /orders/bulk`
validates, persists, enqueues and answers `202` with a `batch_id` and a `status_url`.

### Validation is per order, not per request

```ts
// Items are deliberately unvalidated here. Validating the array with createOrderSchema would
// reject the whole batch over one bad order, and the contract promises per-order outcomes.
export const bulkCreateOrdersSchema = z.object({ orders: z.array(z.unknown()).min(1) });
```

Only the envelope is validated at the edge. Each order is then parsed individually inside
`BulkOrderService.submit`, and a failure becomes a `RejectedOrder` with its own index, code and
field-level details. The response tells the caller exactly which of their 100 orders was bad and
why, instead of `400 Bad Request`.

Three rejection reasons are checked before anything is queued: schema failure, `order_id` duplicated
*within the request*, and an unknown `courier_partner`.

### One job per chunk, grouped by courier

The tension: UrbaneBolt's manifest endpoint is natively batch (15 per call is fastest), but a job
per order gives the best retry granularity. The resolution:

```ts
const byCourier = new Map<string, string[]>();
for (const order of orders) { ...group by order.courierPartner... }

for (const [courierPartner, orderIds] of byCourier) {
  const size = Math.max(1, this.registry.get(courierPartner).capabilities.maxBatchSize);
  for (let start = 0; start < orderIds.length; start += size) {
    await this.queue.add('chunk', { batchId, courierPartner, orderIds: orderIds.slice(start, start + size) }, ...);
  }
}
```

A mixed batch of 20 UrbaneBolt orders and 5 MockCourier orders becomes two chunks of 15 and 5 for
UrbaneBolt (`maxBatchSize: 15`) and five chunks of 1 for Mock (`maxBatchSize: 1`). An integration
test asserts that 20 orders produce exactly two manifest calls with sizes `[15, 5]`.

`BULK_WORKER_CONCURRENCY` chunks are processed in parallel, which is the "concurrently" in the
requirement.

### Partial success inside a chunk

`runNativeBatch` matches the courier's per-item outcomes back to rows by `order_id`, and handles the
case the courier does not mention at all:

```ts
for (const orphan of rowsByOrderId.values()) {
  const error = new AppError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier returned no outcome for this order');
  await this.recordFailure(batchId, orphan, error);
}
```

Without that loop an order the courier silently dropped would sit at `PENDING` forever.

`runOneByOne` (the path for couriers without batch support) rethrows retryable errors so BullMQ can
retry the job, and records non-retryable ones as per-order failures. That distinction is what stops
a courier outage from being permanently recorded as 15 rejected orders.

### The duplicate-on-retry gap

If a chunk is retried after a network failure, some of its orders may already exist at the courier.
UrbaneBolt rejects the duplicate **without returning the AWB**, and offers no lookup-by-order-number
endpoint. So the AWB is genuinely unrecoverable by any automated means:

```ts
if (duplicate) {
  // The courier already has this shipment but its duplicate response carries no AWB, and it
  // exposes no lookup-by-order-number endpoint. Nothing automated can close this gap.
  this.logger.error({ orderId, courierPartner }, 'Courier reports the order as already shipped without returning an AWB; manual reconciliation required');
}
```

The order goes to `RECONCILIATION_REQUIRED`, `GET /orders?status=RECONCILIATION_REQUIRED` lists them
for an operator, and `POST /retry` refuses them explicitly rather than pretending. This is a real
gap in the courier's API, documented rather than papered over.

### The worker supervisor

This one came out of pulling the plug on Redis while the system was running.

After a Redis outage, BullMQ's worker reports `isRunning() === true` while silently processing
nothing — a job added after recovery is never picked up. Reproduced in isolation:

```
BEFORE outage:      isRunning=true  processed=1
DURING outage:      isRunning=true  processed=1
AFTER recovery:     isRunning=true  processed=1
AFTER adding job b: isRunning=true  processed=1   <- never processed
```

So `isRunning()` cannot be the health signal. `superviseWorker` watches the *queue* instead:

```ts
// A BullMQ worker that loses Redis mid-blocking-read comes back reporting isRunning() === true
// while silently consuming nothing... This watches the queue instead — jobs waiting with nothing
// active across two consecutive checks means the worker is not reading, and it is replaced.
const [waiting, active] = await Promise.all([queue.getWaitingCount(), queue.getActiveCount()]);
if (waiting === 0 || active > 0) { stalledChecks = 0; return; }
stalledChecks += 1;
if (stalledChecks < 2) return;
```

Two consecutive checks, not one, so a chunk that legitimately takes longer than the interval is not
mistaken for a stall. Verified end to end: a batch submitted during an outage completes about four
seconds after Redis returns.

Fixing this also fixed a subtler bug. A single ioredis client was being shared between the Queue and
the Worker; BullMQ *duplicates* whatever client it is handed for blocking commands, and those
duplicates carry no `error` listener — so a Redis outage produced unhandled error events, which Node
promotes to uncaught exceptions, which the fail-fast handler turned into a process exit. It now
receives connection *options* and owns its own clients, with `error` listeners attached to the
Queue and Worker.

---

## 11. Configuration

All configuration is environment variables, parsed once at boot by a zod schema, exposed as a typed
`AppConfig`. Nothing anywhere reads `process.env` directly except the container's
convention-based lookups.

Two details worth knowing.

**Blank values are treated as unset:**

```ts
// dotenv turns a bare `API_KEY=` into an empty string rather than leaving it unset, which would
// otherwise fail min-length checks instead of falling back to the default.
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
}
```

This came from an actual failed boot: `API_KEY=` in `.env` became `''`, failed `min(1)`, and the
process refused to start.

**A bad variable is named.** The config error carries zod's field-level details, and `server.ts`
logs them:

```ts
bootstrapLogger.fatal({ invalid: isAppError(error) ? error.details : undefined, err: error }, 'Server failed to start');
```

Fail fast, and say which variable. A misconfigured service should die at boot, not on the first
order.

---

## 12. Observability

**Request correlation** uses `AsyncLocalStorage`. The middleware opens a scope per request; the
logger's `mixin()` reads it, so every log line carries the request id without anything being passed
down through function signatures.

The retry attempt number rides in the same context, for a specific reason:

```ts
// The retry decorator sits outside the audit decorator, so the attempt number cannot be passed
// down the call chain. It is stamped on the ambient context instead.
```

That is what makes `courier_api_logs` show three rows for a retried call, numbered 1, 2, 3.

**Access logging** is `pino-http`, one line per request with method, path, status and duration. It
deliberately drops to `warn` rather than `error` on a 5xx, because `ErrorHandler` has already logged
that failure with its stack and courier context; this line is the access record, not a second report
of the same event. `/health` and `/docs` are excluded — a readiness probe every five seconds would
otherwise be most of the log volume.

**Redaction** is configured on the logger for `authorization`, `x-api-key`, `*.password` and
`*.access_token`. The auth request body is also redacted *before* it reaches the audit table:

```ts
auditBody: { username: this.config.username, password: '[redacted]' },
```

Redacting at the log sink alone would have left the password in the database.

---

## 13. API documentation

One source of truth, two artifacts:

```
zod schemas (the ones that validate requests)
  └── @asteasolutions/zod-to-openapi  →  docs/openapi.json (OpenAPI 3.1)
        ├── swagger-ui-express        →  GET /docs
        └── openapi-to-postmanv2      →  postman/multi-courier.postman_collection.json
```

Because the OpenAPI document is generated from the *same* schemas Express validates with, the docs
cannot describe a request the API would reject. Hand-written OpenAPI always drifts.

Each component registers its own paths — `orders.openapi.ts`, `couriers.openapi.ts`,
`health.openapi.ts` — and `src/openapi.ts` imports all three, so documentation lives next to the
routes it documents rather than in one growing file.

Generation is one command, `npm run docs:generate`, and the script does a small amount of
post-processing that the converter cannot do on its own — see section 14.

---

## 14. Testing, and what running the tests actually caught

```
tests/unit/          config, error handler, status map, error classifier, decorators, presenter
tests/integration/   real Express + real Postgres + real Redis, courier stubbed with nock
tests/helpers/       harness, infrastructure, stub adapter
```

85 tests. Integration tests use testcontainers by default and fall back to
`TEST_DATABASE_URL`/`TEST_REDIS_URL` locally, which is much faster — and which is also what CI uses,
since the runner already provides Postgres and Redis as services.

Every test file has at least one test asserting a *specific failure*, not just a happy path — a
suite that only proves the good case is a suite that cannot fail usefully.

Three things worth recording about the process rather than the code.

**The suite was mutation-checked.** After adding the leak guard, `presentFailure` was deliberately
broken to return the stored courier text; the test failed; the change was reverted. A test that has
never been seen to fail is not yet evidence of anything.

**Running the Postman collection found bugs the tests did not.** Generating a collection is not the
same as having a working one. Running it with newman surfaced, in order:

1. The collection's `baseUrl` was `/` — every request went to `//api/v1/orders`. The OpenAPI
   document had `servers: [{ url: '/' }]`; it now uses a server *variable* defaulting to
   `http://localhost:3000`, which both Swagger UI and Postman expose as a single editable value.
2. Request bodies were generated from schema constraints, so the create body contained
   `"date": "3974-67-82"`, a phone number of control characters and `weight_kg: 753.94`. Import and
   Send gave a 422. The schemas now carry real examples.
3. `X-API-Key` appeared nowhere. There was no security scheme in the document, so with `API_KEY` set
   every request 401s with no hint. There is now an `ApiKeyAuth` scheme, which also gives Swagger UI
   its **Authorize** button.
4. The query parameters were documented from a hand-written duplicate of the real schema — `status`
   was `string` when the API accepts an enum. The real `listOrdersQuerySchema` and
   `serviceabilityQuerySchema` are now the documented ones, which removed the duplication as well as
   the inaccuracy.
5. The bulk request body generated as `{"orders": []}` — the converter ignores an object-level
   example when the array items are untyped, and the endpoint rejects an empty array. The bulk
   example moved to the media type.
6. The capture script used `const data`, which collides with a Postman sandbox global and failed
   every request's tests with a `SyntaxError`.

It also surfaced a mismatch between the code and the recorded design decision. The plan says the
unified DTO is "strict, no passthrough", but `z.object()` *strips* unknown keys rather than
rejecting them, so `POST /orders` was quietly accepting and discarding anything it did not
recognise. For a shipping API that is a real hazard — a typo'd `collectible_amount` would ship a COD
parcel for zero rupees with no error anywhere. The request schemas now use `z.strictObject`, and a
test asserts the rejection.

And then the finding that mattered most: with the collection actually running, `GET /orders/ORD-1002`
came back with `"message": "Consignee Pincode 999999 is not serviceable"` — the courier's own
wording, on a route nobody had tested for it. That is the leak described in section 8, and it was
invisible to a suite that only checked the error envelope.

**Running it a second time found the rest.** Regenerating the collection twice and diffing showed
that six of the eight fixes above were stable but the enum query parameter was not: the converter
answers "give me an example of this enum" by picking a member at random, so `?status=` changed on
every regeneration. Repeating the check twelve times is what turned "looks deterministic" into
"is deterministic" — a single diff had passed by luck.

**The collection is now runnable, not just importable.** Four variables, real bodies, and a
collection-level test that carries `order_id` and `batch_id` into the following requests, so a
reviewer can import it and run it top to bottom:

```
newman run postman/multi-courier.postman_collection.json
→ 12 requests, 24 assertions, 0 failed
```

Each request asserts two things: that the body is the standard envelope, and that the status is
below 500. The second one matters more than it looks — the error envelope is itself a valid
envelope, so without it a route answering `500` passed the run. Verified by stopping Postgres and
re-running: 8 assertions fail, where before the change all 12 passed against a broken stack.

---

## 15. Continuous integration

`.github/workflows/ci.yml`, five jobs. They are split rather than sequential so that the fast
feedback is fast: `static` needs no services and finishes in under a minute, while `e2e` builds
images.

| Job | What it proves | Why it exists |
|---|---|---|
| `static` | lint, formatting, types, build, `npm audit --omit=dev` | Prettier was configured but never enforced, and 24 files had drifted out of style |
| `generated` | `docs:generate` and `db:generate` produce no diff | The OpenAPI document, the collection and the SQL migrations are all derived from code that a change can silently outdate |
| `test` | 85 tests against real Postgres and Redis, with coverage (77% of statements) | The suite is the contract |
| `e2e` | `docker compose up`, then the Postman collection with newman | Proves the thing a reviewer actually runs, end to end, with no credentials |
| `image` | The Docker image builds; `main` publishes it to GHCR | A Dockerfile that is never built is a Dockerfile that does not work |

**The `generated` job needed a code change to be possible at all.** `openapi-to-postmanv2` stamps a
fresh UUID on the collection and on every item and example response, so two runs over an unchanged
schema differed by around 250 lines of pure noise — no diff check could tell a real change from a
regenerated id. Worse, the envelope's `success` field was `z.boolean()`, and the converter answers
"give me an example of a boolean" by *picking one at random*: the committed collection had example
bodies showing `{"success": false}` next to a `201 Created`. Both are fixed at the source —
`z.literal(true)` / `z.literal(false)` per status, and the generator strips the ids Postman
re-assigns on import anyway. Generation is now byte-for-byte reproducible, which is what makes the
check meaningful.

The audit step is deliberately split in two. `npm audit --omit=dev --audit-level=high` blocks the
build; the full audit runs advisory-only. The nine advisories in this tree are all in
`openapi-to-postmanv2`'s transitive dependencies — a dev-time documentation generator that no
runtime path reaches, and whose fix is a major downgrade that breaks the collection. A gate that
fails for reasons nobody can act on is a gate everyone learns to ignore.

**Writing the `test` job found a bug that the suite could never have shown locally.** Vitest runs the
three integration files in parallel, and with `TEST_DATABASE_URL` set they share one database — so
all three race to apply the same migrations. Against a warm database the migrator finds nothing to
do and the race is invisible, which is why it had never been seen. Against a *fresh* one, which is
what a CI service container is every single run, two files out of three died on:

```
Failed query: CREATE TYPE "public"."batch_item_status" AS ENUM(...)
Caused by: duplicate key value violates unique constraint "pg_type_typname_nsp_index"
```

`tests/helpers/infrastructure.ts` now takes a Postgres advisory lock around the migration, held on a
client checked out of the pool for the duration — an advisory lock belongs to a *session*, so taking
it with a pooled query would put it on whichever connection happened to be free rather than the one
running the migration. Verified by dropping the volume and running cold three times: 36 of 36, three
times over, where before the fix a cold run failed reliably.

`e2e` runs fully offline: `cp .env.ci .env` points the UrbaneBolt adapter at the WireMock container,
so CI needs no credentials and no network egress to a third party.

Exercising it end to end also showed the WireMock manifest stub could only speak for one order — it
echoed `$[0].orderNumber` — so a bulk submission offline reported 17 of 18 orders as unacknowledged
while the platform was behaving correctly. The stub now splits the request with two jsonPath-filtered
loops and reports per-item outcomes the way the real endpoint does. Filtering inside a single loop
would have emitted a leading comma whenever the first item was a rejection; the split is what keeps
the rendered JSON valid in every combination.

`.github/dependabot.yml` groups dev-tooling and runtime-patch updates so the weekly result is two
reviewable PRs rather than a dozen.

---

## 16. Decisions, and what was rejected

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Courier selection | Registry + `CourierAdapter` interface | `switch (courier_partner)` — every new courier edits shared code |
| Cross-cutting concerns | Decorator chain around the adapter | Base class with hooks — inheritance fixes the order and the combination at compile time |
| Retry classification | Adapter sets `retryable` | Decorator inspects status codes — that is courier knowledge outside the courier |
| Auth refresh | Decorator asks `isAuthFailure()` | Decorator matches 401 — UrbaneBolt is 401-with-a-different-body, others differ again |
| Bulk unit of work | One job per chunk, grouped by courier | Job per order (loses native batching); job per batch (one failure retries everything) |
| Idempotency | Insert `PENDING` before calling the courier | Check-then-insert — races, and loses evidence of crashed attempts |
| Duplicate on retry | `RECONCILIATION_REQUIRED` + manual endpoint | Guessing the AWB, or silently succeeding |
| Tracking freshness | Live call, TTL-guarded, append-only diff | Cache-only (stale) or call-every-time (hammers the courier) |
| Error messages | Normalized codes + our wording, raw kept server-side | Passing the courier's text through — leaks internals, couples our contract to theirs |
| Client message safety | Narrowed `ClientFacingErrorCode` type | Runtime `?? courierMessage` fallback — silently leaks the first time a code is missed |
| Batch validation | Per order, inside the service | Whole-array zod schema — one bad order rejects 99 good ones |
| Unknown request fields | Rejected (`z.strictObject`) | Stripped (zod's default) — a typo in a money field becomes a silent zero |
| Config | zod at boot, fail fast | Reading `process.env` at use site — fails on the first order instead of at startup |
| DI | Hand-written composition root | Container library — magic in exchange for a question a readable file already answers |
| Boundaries | ESLint `no-restricted-imports` | A convention in a document — documents rot silently |
| API docs | Generated from the request schemas | Hand-written OpenAPI — drifts from the code within a sprint |
| Worker health | Watch the queue depth | `worker.isRunning()` — proven to report `true` while consuming nothing |
| Timestamps | Explicit IST parser | `new Date(string)` — correct on a laptop in India, wrong in a UTC container, silent either way |
| Body-parser failures | Translated next to the parser | Left to the generic handler — a stray comma became a 500 logged as a programmer fault |
| API key comparison | Constant-time over SHA-256 digests | `!==` — returns early, so response time leaks how much of the key was guessed |
| Shutdown | Bounded, then exit anyway | Unbounded `server.close()` — one keep-alive socket holds the container until SIGKILL |
| Generated artifacts | Deterministic, diffed in CI | Regenerated by hand — drifts, and the noise hides the drift |

---

## 17. Design patterns, and what each one is buying

A pattern that is not paying for itself is decoration. Each of these is here because a specific
requirement or a specific failure mode made it the cheaper option.

| Pattern | Where | What it buys |
|---|---|---|
| Adapter | `integrations/*/`, `courier.interface.ts` | One shape for many couriers |
| Registry + Factory | `courier.registry.ts`, `CourierDescriptor` | Adding a courier is an import line |
| Strategy | `registry.get(courier_partner)` | Runtime selection with no `switch` |
| Decorator | `domain/decorators/` | Retry, re-auth and audit, once, for every courier |
| Repository | `*/data-access/` | Services depend on a method, not on SQL |
| Composition root | `container.ts` | The object graph on one screen |
| Chain of responsibility | `app.ts` middleware | Each concern in its own file, ordered explicitly |
| Module facade | `components/*/index.ts` | A component's surface is what it chooses to export |
| Mapper / Presenter | `*.mapper.ts`, `order.presenter.ts` | Wire shapes never reach the domain, or vice versa |
| Producer–consumer | `bulk-order.service.ts` + `worker.ts` | 100 orders answer in milliseconds |
| Supervisor | `superviseWorker()` | A worker that stops consuming gets replaced |
| Ambient context | `libraries/context/` | Correlation without threading a parameter through every call |

### Adapter, and why the interface has optional methods

`CourierAdapter` is the whole contract. `createShipment`, `trackShipment` and `cancelShipment` are
required; `createShipments` and `checkServiceability` are optional, and a `capabilities` object
declares what is really there:

```ts
export interface CourierAdapter {
  readonly id: string;
  readonly capabilities: CourierCapabilities;
  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>>;
  createShipments?(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>>;
  ...
}
```

The alternative is a required method that throws "not supported" — which turns a fact known at
startup into an exception at 2am. Here `GET /api/v1/couriers` publishes the same capabilities the
bulk service reads when it decides whether to chunk, so callers and code work from one answer.
MockCourier declaring `supportsServiceability: false` is why `GET /serviceability?courier_partner=mock`
answers `400 OPERATION_NOT_SUPPORTED` naming the courier, rather than pretending.

### Registry + Factory, and where the "add a courier" requirement is actually met

A `CourierDescriptor` is a factory plus its own enablement rule:

```ts
export type CourierDescriptor = {
  readonly id: string;
  readonly displayName: string;
  isEnabled(env: NodeJS.ProcessEnv): boolean;
  create(env: NodeJS.ProcessEnv, deps: CourierFactoryDependencies): CourierAdapter;
};
```

`buildRegistry` walks the descriptors, skips the disabled ones, calls `create`, wraps the result in
the decorator chain and registers it. The courier reads its own configuration in its own `create`,
so `container.ts` never learns a courier's environment variables. Adding a courier is a folder plus
one line in `integrations/index.ts` — controllers, DTOs, services and the other adapters are not
touched, which is requirement 3.2 discharged structurally rather than by discipline.

### Strategy, and the rule that keeps it honest

`courier_partner` picks the adapter. What makes this a real Strategy rather than a dressed-up
conditional is that no courier name appears anywhere outside `src/integrations/` — enforced by an
ESLint `no-restricted-imports` rule, not by a convention in a document. Section 2.

### Decorator, and why the order is not arbitrary

```
RetryingCourierAdapter( AuthRefreshingCourierAdapter( AuditLoggingCourierAdapter( adapter ) ) )
```

Audit innermost gives one `courier_api_logs` row per HTTP attempt rather than per logical operation
— which is what makes a retried call show three rows numbered 1, 2, 3. Auth refresh inside retry
means a dead token costs one re-authentication instead of burning a transport retry. Retry outermost
means backoff applies only to genuine transport failures.

Inheritance would have fixed both the order and the combination at compile time. Composition lets
`container.ts` decide, and lets a courier opt out of one layer without a new subclass. Section 6
covers the two hooks — `retryable` and `isAuthFailure`/`invalidateAuth` — that let a generic
decorator act on courier-specific knowledge without holding any.

### Composition root

`container.ts` builds every object once, wires them, and returns them. No decorators, no reflection,
no container library. The whole graph is one readable function, which means "what depends on what"
is answered by reading rather than by tracing annotations. `createContainer(config, env)` takes `env`
as a parameter rather than reading `process.env`, which is what lets the test harness build a fully
real container against different configuration without touching globals.

### Chain of responsibility

The Express middleware stack is the classic form: each handler either finishes the response or calls
`next()`. What is worth noticing is that the *order* is load-bearing and now documented as such —
request id before the body parser, so a request that fails to parse still has a correlation id.
Section 4.

### Mapper and Presenter — three shapes, deliberately

```
snake_case DTO  --toNormalizedOrder-->  NormalizedOrder  --urbanebolt.mapper-->  manifest item
                                              |
                                       order.presenter
                                              v
                                      snake_case response
```

Three translations rather than one shared shape. It costs boilerplate and buys the thing the whole
assignment is about: the courier's field names never reach a controller, and our public contract
never has to change because a courier renamed a field. `order.presenter.ts` is also where the
courier's own error wording is replaced with ours — section 8.

### Producer–consumer, and the supervisor over it

`POST /orders/bulk` validates, writes batch rows, enqueues chunk jobs and answers `202` with a
`batch_id`; the worker consumes. That is what makes 100 orders answer in milliseconds instead of
holding a connection open for a minute. Chunking is by `capabilities.maxBatchSize`, so a courier
with a native batch endpoint gets one call per 15 orders and one without gets one per order — the
same code, different capability.

The supervisor exists because of a measured failure: a BullMQ worker that loses Redis mid-blocking-read
comes back reporting `isRunning() === true` while silently consuming nothing. So the supervisor
watches the *queue* instead of the worker — jobs waiting with nothing active across two consecutive
checks means replace it. Section 10.

### Ambient context

`AsyncLocalStorage` carries the request id and the retry attempt number. The alternative is threading
a context parameter through every service, repository and adapter signature — including the ones
inside third-party callbacks. The retry attempt in particular *cannot* be passed down: the retry
decorator sits outside the audit decorator, so there is no call chain between them to pass it along.

### What is deliberately not here

**No circuit breaker.** Retry with jittered backoff plus a per-request timeout covers the failure
modes this system actually has. A breaker adds state that has to be shared across replicas to mean
anything, and gets it wrong quietly. Noted as the next step rather than half-built.

**No base class for adapters.** A `BaseCourierAdapter` with hooks would look tidy and would fix the
cross-cutting behaviour into the inheritance chain, which is precisely what the decorators exist to
avoid.

**No generic `Repository<T>`.** Each repository exposes the few queries its service needs
(`insertPending`, `markShipmentCreated`) rather than a CRUD surface. A generic base would push query
construction back into the services, which is the thing being prevented.

---

## 18. Where to look for what

| Question | File |
|---|---|
| What does a courier have to implement? | `components/couriers/domain/courier.interface.ts` |
| How is a courier registered? | `integrations/index.ts`, `components/couriers/domain/courier.registry.ts` |
| How do retries work? | `components/couriers/domain/decorators/retry.decorator.ts` |
| What counts as a failure at UrbaneBolt? | `integrations/urbanebolt/urbanebolt.errors.ts` |
| Where is the object graph? | `container.ts` |
| What are the error codes and statuses? | `libraries/errors/error-codes.ts` |
| How is idempotency implemented? | `components/orders/data-access/order.repository.ts` (`insertPending`) |
| How is a bulk batch chunked? | `components/orders/domain/bulk-order.service.ts` (`enqueue`) |
| What did we send to the courier? | `courier_api_logs`, or `request_payload` on the order row |
| Why is this endpoint documented that way? | `*.openapi.ts` next to the routes |
| What does CI check, and where? | `.github/workflows/ci.yml` |
| How do I run the whole stack with no credentials? | `.env.ci`, then `docker compose up --wait` |
