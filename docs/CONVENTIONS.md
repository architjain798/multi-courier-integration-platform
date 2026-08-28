# Conventions

Rules this codebase actually follows. Where a rule is mechanically checkable it is an ESLint rule,
not a paragraph — see `eslint.config.js`.

## TypeScript

`strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`verbatimModuleSyntax`.

- **No `any`.** `unknown` at untrusted boundaries — courier responses, `process.env`, `catch` clauses —
  narrowed immediately, usually by zod.
- **No `as`, no `!`.** Both silence the compiler without adding a runtime check. Narrow with a real
  check instead. On the rare occasion one is genuinely safe, the line above it says why.
- **Let inference do local work; annotate boundaries.** Exported function signatures, public types,
  and anything crossing a component edge are explicit. Locals are not.
- **No `I` prefix on interfaces.** `CourierAdapter`, never `ICourierAdapter`. If a name needs a
  prefix to distinguish it from its implementation, the name is wrong.
- `interface` for contracts something implements; `type` for unions, aliases, and mapped types.
- `readonly` on anything not meant to mutate — adapter `capabilities` especially.
- Optional fields use `?`, not `| undefined`.
- **Named exports only.** A courier module exports `export const urbaneBoltDescriptor` so the barrel
  reads `import { urbaneBoltDescriptor } from './urbanebolt'` — greppable, renameable, no ambiguity
  about what a file provides.
- Function declarations for named functions; arrow functions for callbacks and typed expressions.
- `UpperCamelCase` types, `lowerCamelCase` values, `CONSTANT_CASE` module-level constants.

Follows the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) where
it and this project disagree with common tutorial habits.

## Errors

Per [Node Best Practices](https://github.com/goldbergyoni/nodebestpractices#2-error-handling-practices):

- **Only the built-in `Error`.** `AppError extends Error`, `CourierError extends AppError`. Never
  throw a string, never throw a bare object, never reject with a non-Error.
- **Operational vs programmer errors are distinguished.** `AppError` carries `isOperational`.
  An operational error — pincode not serviceable, courier timed out — becomes a normalized envelope.
  A programmer error — undefined property, bad assumption — is a 500, logged with its stack, and not
  dressed up as a business outcome.
- **One centralized handler.** The Express error middleware and the BullMQ failure handler both
  delegate to the same `errorHandler` object. Two entry points, one policy.
- **Fail fast at every edge.** zod validates request bodies, `process.env` at boot, and each enabled
  courier's config at boot. A missing `URBANEBOLT_USERNAME` kills the process at startup with the
  variable named, not on the first order at 3am.
- **Never swallow.** No empty `catch`. No `catch { return null }`. If a catch cannot do something
  meaningful, it should not exist — let it propagate to the central handler.

## SOLID, as it applies here

Not recited abstractly — these are the specific places the principles do work:

- **SRP** — `urbanebolt.mapper.ts` contains no `fetch`. `urbanebolt.client.ts` contains no domain
  vocabulary. `urbanebolt.errors.ts` decides what "failed" means and nothing else. If a file needs
  "and" to describe it, it splits.
- **OCP** — this _is_ requirement 3.2. A new courier is a new folder plus one import line; nothing
  existing is edited. The registry is closed for modification, open for extension.
- **LSP** — every adapter must be substitutable behind `CourierAdapter`. `MockCourierAdapter` exists
  partly to prove the contract holds for something that is not UrbaneBolt.
- **ISP** — `createShipments?` and `checkServiceability?` are optional rather than forced onto every
  courier as stubs that throw. `capabilities` gates them, so no adapter implements what it cannot do.
- **DIP** — services depend on the `CourierAdapter` interface and repository interfaces. Concrete
  types are injected once, in `container.ts`. No service constructs its own dependencies.

## Code that reads as written by someone

The [tells reviewers actually cite](https://tenki.cloud/blog/reviewing-ai-generated-code) are
structural, not cosmetic: monotonous file shapes, happy-path-only logic, silently swallowed errors,
and tests that pass regardless. Formatting is not the problem. So:

- **No JSDoc. No comments restating the code.** Types and names carry it. A comment appears only
  where the code genuinely surprised the person writing it — `urbanebolt.errors.ts` gets one,
  because "HTTP 200 means the request failed" is surprising and the next reader deserves the warning.
- **No banner comments**, no `// ===== ROUTES =====`, no emoji in logs or identifiers.
- **No defensive `try/catch` around code that cannot throw.** Catch where there is a decision to make.
- **Files are allowed to differ in size and shape.** `mock.adapter.ts` is short and direct because
  the mock is short and direct. `urbanebolt.adapter.ts` is longer because the real API is messier.
  Flattening them into identical templates is the monotony reviewers notice.
- **Tests must be capable of failing.** Every module has at least one test asserting a specific
  failure — an error `code`, a message, a status — not `expect(result).toBeDefined()`. Tests for the
  200-with-`status: Failed` path, the expired-token path, and bulk partial success matter more than
  another happy-path assertion.
- **Short names in short scopes**, full names at boundaries. `for (const o of orders)` is fine;
  an exported function parameter called `o` is not.
- **Barrels only where there is a real public interface** — `components/*/index.ts` and
  `integrations/index.ts`. No barrel that re-exports a folder for its own sake.
- **No dependency for something the standard library does.** `crypto.randomUUID()`, not `uuid`.
- **TODOs are real or absent.** A TODO states what and why, or it does not get written.

## Enforced in CI

```
@typescript-eslint/no-explicit-any            no any
@typescript-eslint/no-non-null-assertion      no !
@typescript-eslint/no-floating-promises       every promise awaited or explicitly voided
@typescript-eslint/no-misused-promises        catches async Express handlers passed as sync
@typescript-eslint/await-thenable
@typescript-eslint/no-unnecessary-condition   catches checks that can never be false
no-empty (allowEmptyCatch: false)             no swallowed errors
no-console                                    pino only
no-restricted-imports                         no deep imports across component boundaries
```

`no-restricted-imports` is the one worth calling out: `components/orders` may import
`components/couriers`, but not `components/couriers/domain/anything`. The boundary is checked by CI
rather than left to discipline.
