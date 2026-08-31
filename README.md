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
type Logger = pino.Logger
```

`resolveEnvironment` and `resolvePretty` are exported so the decisions they make
are testable without spawning a process.

## Licence

MIT.
