# Changelog

## 2.0.0

**BREAKING: if your application has its own `SIGTERM` or `SIGINT` handler, the
preload no longer exits the process for you. Your handler must end it.** A
handler that only logged, or closed something, and relied on this package to
exit, will now run until its supervisor's stop timeout. Call
`flushTelemetry()` and then `process.exit()` at the end of it. An application
with NO handler of its own is unaffected.

This is a major version for that reason alone: a range such as `^1.1.0` must
not deliver it unasked.

### Changed

- **The preload no longer ends a process that has its own graceful shutdown.**
  On `SIGTERM` and `SIGINT` it shut telemetry down and called
  `process.exit(0)`, always. Signal handlers do not take turns, and the preload
  registers first: an application that had started waiting for its in-flight
  work was ended a few milliseconds later, by its telemetry library. Nothing
  crashed and the exit code was `0`, so it read as a clean stop.

  The preload now exits only when the application has **no** handler of its
  own for the signal. When it has one, the application ends the process.
  This is judged when the signal arrives, so an application signalled during
  start-up, before it registered a handler, is still ended promptly.

  An application whose handler already ends the process (most do: that is
  what the handler is for) needs no change beyond, optionally, the flush
  below. An application with no handler behaves exactly as before.

### Added

- **`flushTelemetry(limitMs?)`**, from the main entry. Call it last in your own
  shutdown handler, before `process.exit()`, so spans still buffered are sent.
  It never rejects and never keeps the process alive: it resolves `"flushed"`,
  `"timed_out"` after `TELEMETRY_FLUSH_LIMIT_MS` (two seconds), or
  `"not_running"`. A flush that fails is reported by the error's class name
  only; an error's message can carry a collector address.

### Notes

- The preload has **no timer of its own**. If an application's handler never
  ends the process, the supervisor's stop timeout is the backstop. A timer
  here would be a second place that can cut a shutdown short.
- **Why no test found this:** the preload does nothing unless
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so a process started with the preload
  and no collector address stops perfectly. The new tests start a real process
  with both, as a deployment does. One of them asserts the inert case too, so
  the trap is written down where the next test will be written.

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
