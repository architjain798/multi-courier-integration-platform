# Multi-Courier Integration Platform

Courier-agnostic shipping API. Consumers call one contract and pass `courier_partner`; each courier
lives behind an adapter. UrbaneBolt is the first real integration, MockCourier the second.

Read [PLAN.md](PLAN.md) for the design and [docs/CONVENTIONS.md](docs/CONVENTIONS.md) for the rules
the code follows. Both are current — if code and plan disagree, that is a bug in one of them.

## Commands

```
npm run dev              API with reload (WORKER_INLINE=true runs the queue worker in-process)
npm run dev:worker       queue worker on its own
npm run build            tsc
npm run lint             eslint
npm run typecheck        tsc --noEmit
npm test                 vitest
npm run test:int         integration suite (needs docker for testcontainers)
npm run db:generate      drizzle-kit generate
npm run db:migrate       apply migrations
npm run docs:generate    write docs/openapi.json + regenerate the Postman collection
docker compose up        postgres, redis, wiremock, api, worker
```

## Layout

Component-based, three layers per component. Full tree in [PLAN.md §5](PLAN.md).

```
src/components/orders      entry-points/{api,queue} · domain · data-access
src/components/couriers    the contract, registry, and decorators — no concrete courier
src/integrations           <<< concrete adapters live here. urbanebolt/ · mock/
src/libraries              config · logger · errors · http · openapi · queue
src/container.ts           the composition root: the whole object graph on one screen
```

`components/orders` imports `components/couriers` through its `index.ts` only, never a deep path.
ESLint enforces it.

## Things about the UrbaneBolt API that will bite you

Verified by calling the UAT API — details in [docs/urbanebolt-api-findings.md](docs/urbanebolt-api-findings.md).

- **HTTP 200 does not mean success.** Business failures come back `200` with `{"status":"Failed"}`
  or a populated `errorResponse[]` / `failureResponse[]`. Only an expired token returns a real `401`,
  and it uses a different body shape. Classification lives in `urbanebolt.errors.ts` — nowhere else.
- **`/services/manifest/` takes an array.** It is natively batch and reports per-item outcomes.
  The bulk worker chunks by `capabilities.maxBatchSize` rather than firing one call per order.
- **The token is stable with a 24h TTL** — `getToken` returns the same token until it expires.
- **A duplicate `orderNumber` is rejected without returning the AWB**, and there is no
  lookup-by-orderNumber endpoint. A retried create that actually succeeded therefore cannot be
  auto-reconciled; it becomes `RECONCILIATION_REQUIRED`. This is a real gap, not an oversight.
- Response keys are inconsistent between endpoints: `errorResponse` on manifest, `failureResponse`
  on cancel.

## Hard rules

- No JSDoc. No comments restating code. A comment only where something is genuinely surprising.
- No `any`, no `as`, no `!`. Narrow properly.
- Only `Error` subclasses are thrown. Operational errors carry `isOperational`.
- Nothing courier-specific outside `src/integrations/`. No courier name in a service or controller.
- Config comes from env via zod. Nothing hardcoded — base URLs, credentials, timeouts, retry counts.
- Every test file has at least one test that asserts a specific failure, not just a happy path.

## Adding a courier

New folder under `src/integrations/`, export a `CourierDescriptor`, add one import line to
`src/integrations/index.ts`. Controllers, DTOs, services, and existing adapters are not touched.
