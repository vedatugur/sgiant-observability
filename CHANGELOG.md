# Changelog

## 1.1.0

`logger` and `telemetry` became one package, `sgiant-observability`. Logging and
tracing are one concern; two packages that always travel together are one
package with extra ceremony.

**Two entry points, and the separation between them is load-bearing.**

- `.` → `dist/index.js` — `createAppLogger`, `loggerOptions`, `Logger`.
- `./register` → `dist/register.js` — the OpenTelemetry bootstrap. Side effect
  only, preloaded via `NODE_OPTIONS="--require sgiant-observability/register"`.

`register` must run **before** anything the auto-instrumentations patch — pino
included. So `index.ts` must never import `register.ts` and `register.ts` must
never import `index.ts`. A single import either way drags pino into the process
before instrumentation-pino can patch it, and the only visible symptom is logs
that quietly stop carrying trace ids. Merging the two packages is what made that
mistake reachable in the first place, so a test asserts the two files stay
disjoint.

Two fixes carried over from before the merge, both of the "installs fine, then
fails" class — the kind that only appear once someone other than the author
installs the package:

- **`pino-pretty` is a dependency, not a devDependency.** `createAppLogger()`
  passes `transport: { target: "pino-pretty" }`, and a transport target is a
  specifier pino resolves at runtime. No static import names it, so nothing in a
  monorepo notices: the devDependency is hoisted and everything works. An
  outside installer got `unable to determine transport target`.
- **`types` is declared for both entry points.** The tracer had a `main` and an
  `exports` path but no `types` at all, so it shipped a declaration file nothing
  verified.

### Fixed

- **Deployed environment is resolved from three names, not one.** Logs read
  `environment: "development"` on a production host whose own config, on the
  same line, read `prod` — so anyone filtering by environment looked for prod
  lines in the dev bucket. `SGIANT_ENV`, `APP_ENV` and `NODE_ENV` are now all
  consulted, in that order.
- **Pretty-printing no longer switches itself on in production.** On a host with
  `NODE_ENV` unset, `!== "production"` was true and pino-pretty replaced the
  structured JSON with colourised text — reaching the log backend with no
  parseable `severity` and no queryable fields at all. The `NODE_ENV` test is
  kept rather than replaced, so this is a strict narrowing: anything that
  already set `NODE_ENV` behaves exactly as before.

## 1.0.0

Initial release: GCP-native tracing, container metrics and structured logs, with
a consistent `service` + `component` pair for cross-app filtering.
