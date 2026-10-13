# sgiant-observability

A [pino](https://getpino.io) logger and an [OpenTelemetry](https://opentelemetry.io)
bootstrap in one package, wired together so your log lines carry the trace ids of
the request that produced them.

Logging and tracing are one concern. Two packages that always travel together
are one package with extra ceremony.

- **Structured JSON in production, pretty output at a terminal** — decided from
  the environment, not from a flag you have to remember.
- **Trace correlation, automatically** — every line stamped with `trace_id` and
  `span_id` when a span is active.
- **Google Cloud Logging shaped** — emits a real `severity` field and
  `logging.googleapis.com/trace`, so Logs Explorer filters by level and links
  each line to its trace.
- **Safe to install and not configure** — with no collector endpoint set, the
  tracer is a no-op and the logger still works.

## Install

```sh
npm install sgiant-observability
```

Requires Node 20 or newer.

## Two entry points, and they are separate on purpose

### `sgiant-observability` — the logger

```ts
import { createAppLogger } from "sgiant-observability";

const log = createAppLogger("api", "checkout");

log.info({ orderId }, "order placed");
```

Every line carries `service`, `environment`, a GCP `severity`, and — when a span
is active — `trace_id` and `span_id`.

With a framework that builds its own pino instance, hand it the same options so
its logs match:

```ts
import Fastify from "fastify";
import { loggerOptions } from "sgiant-observability";

const app = Fastify({ logger: loggerOptions });
```

### `sgiant-observability/register` — the tracer

A side-effect preload. It has no exports, and **it must run before your app
imports anything it is meant to instrument**:

```sh
NODE_OPTIONS="--require sgiant-observability/register" node dist/main.js
```

```dockerfile
ENV NODE_OPTIONS="--require sgiant-observability/register"
```

**Do not `import` it from your application code.** The auto-instrumentations
patch libraries — pino among them — by intercepting their module load, so
anything loaded before `sdk.start()` is never patched. An ordinary import runs
too late.

The failure is silent, which is why it is worth stating twice: nothing crashes
and nothing warns. Your logs simply stop carrying trace ids.

#### Stopping: who ends the process

On `SIGTERM` and `SIGINT` the preload shuts telemetry down, which flushes it.
Whether it then **exits** depends on your application:

- **Your application has no handler of its own for the signal.** The preload
  flushes and exits `0`. Nothing for you to do.
- **Your application has its own graceful shutdown.** The preload leaves the
  signal alone. Your handler ends the process when its work is done, and calls
  `flushTelemetry()` just before it does:

  ```ts
  import { flushTelemetry } from "sgiant-observability";

  process.on("SIGTERM", async () => {
    await server.close(); // your own shutdown: finish the work in hand
    await flushTelemetry(); // then telemetry
    process.exit(0);
  });
  ```

Up to 1.1.0 the preload exited in both cases; 2.0.0 is a major version because it no longer does. Signal handlers do not take
turns, so it ended the process a few milliseconds into the application's own
shutdown, whatever that shutdown was waiting for.

"Has a handler" is judged when the signal arrives. An application signalled
during start-up, before it has registered one, is ended by the preload.

The preload has no timer. If your handler never ends the process, your
supervisor's stop timeout does (a container's stop grace period, a service
manager's `TimeoutStopSec`).

`flushTelemetry()` never rejects and never keeps the process alive. It resolves
`"flushed"`, `"timed_out"` after two seconds (`TELEMETRY_FLUSH_LIMIT_MS`; pass
another limit as its argument), or `"not_running"` when there is no collector
address or the preload is not loaded. A flush that fails is reported on stderr
by the error's class name only.

To test any of this, set `OTEL_EXPORTER_OTLP_ENDPOINT`. Without it the preload
does nothing at all, and a shutdown test passes for the wrong reason.

## Configuration

Everything is read from the environment. Nothing is required.

| Variable                      | Effect                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Your OTLP collector. **Unset → the tracer is a no-op** and the service runs untraced.              |
| `OTEL_SERVICE_NAME`           | Names the service in traces. Set it per service.                                                   |
| `LOG_LEVEL`                   | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`. Default `info`.                      |
| `GOOGLE_CLOUD_PROJECT`        | Enables the `logging.googleapis.com/trace` field. Unset → plain trace ids.                         |
| `NODE_ENV`                    | `production` turns off pretty-printing.                                                            |
| `SGIANT_ENV` / `APP_ENV`      | Deploy-environment name, stamped on every line as `environment`. Takes precedence over `NODE_ENV`. |

Pretty-printing is on unless the process looks like production — `NODE_ENV=production`,
or a deploy environment of `prod`. Pretty output is for a human at a terminal;
anything parsing your logs wants the JSON.

## API

```ts
createAppLogger(service: string, component?: string): Logger
loggerOptions: pino.LoggerOptions
resolveEnvironment(env?: NodeJS.ProcessEnv): string
resolvePretty(env?: NodeJS.ProcessEnv): boolean
flushTelemetry(limitMs?: number): Promise<"flushed" | "timed_out" | "not_running">
TELEMETRY_FLUSH_LIMIT_MS: number // 2000
type Logger = pino.Logger
```

`resolveEnvironment` and `resolvePretty` are exported so the decisions they make
are testable without spawning a process.

## Licence

MIT.
