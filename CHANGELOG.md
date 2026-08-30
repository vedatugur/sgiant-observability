# @sgiant/observability

## 1.1.0

### Minor Changes

- 4827758: `@sgiant/logger` and `@sgiant/telemetry` become one package, `@sgiant/observability`
  (`#328`). Logging and tracing are one concern; two packages that always travel
  together are one package with extra ceremony. This supersedes the two pending
  changesets that were making each of them publishable separately — their
  substance is kept below, because both were about failures that only show up
  after publishing.

  Two entry points, and **the separation between them is load-bearing**:
  - `.` → `dist/index.js` — `createAppLogger`, `loggerOptions`, `Logger`.
  - `./register` → `dist/register.js` — the OpenTelemetry bootstrap, imported for
    its side effect and preloaded via
    `NODE_OPTIONS="--require /repo/packages/observability/dist/register.js"`.

  `register` must run **before** anything the auto-instrumentations patch — pino
  included. So `index.ts` must never import `register.ts` and `register.ts` must
  never import `index.ts`: a single import either way would drag pino into the
  process before instrumentation-pino could patch it, and the only visible symptom
  would be logs that quietly stop carrying trace ids. Merging the packages is what
  makes that mistake reachable, so `tests/unit/observability-entry-points.test.ts`
  asserts the two files stay disjoint.

  Carried over from the changesets this replaces, because both are about the
  "installs fine, then fails" class:
  - `pino-pretty` is a **dependency**, not a devDependency. `createAppLogger()`
    passes `transport: { target: "pino-pretty" }` whenever pretty-printing is on,
    and a transport target is a specifier pino resolves at runtime — no static
    import names it, so nothing in this repo saw the edge. It worked only because
    npm hoists the devDependency into the root `node_modules`; an outside
    installer would have thrown `unable to determine transport target`.
  - `types` is declared for **both** entry points. `@sgiant/telemetry` had a
    `main` and an `exports` path but no `types` at all, so it shipped a
    declaration file nothing verified. The publish job's entry-point assertion
    walks `main`, `types` and `exports` against the tarball; it now has both
    halves of both entry points to check.
