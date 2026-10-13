/**
 * The logging half of `sgiant-observability` — the `.` entry point.
 *
 * A pino logger preconfigured for structured JSON in production, pretty output
 * at a terminal, and automatic OpenTelemetry trace correlation.
 *
 * Never import `./register` from here. It must run before pino is loaded, and
 * an import from this side defeats that silently — see that file's header.
 */

import pino, { Logger as PinoLogger, LoggerOptions } from "pino";
import { context, trace } from "@opentelemetry/api";

const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;

/**
 * The deployed environment name.
 *
 * Reads the first of `SGIANT_ENV`, `APP_ENV`, `NODE_ENV` that is set, and falls
 * back to `"development"`. Every log line carries the result as `environment`.
 *
 * @param env - Environment to read from. Defaults to `process.env`.
 */
export function resolveEnvironment(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.SGIANT_ENV ?? env.APP_ENV ?? env.NODE_ENV ?? "development";
}

const environment = resolveEnvironment();

/**
 * Whether to pretty-print rather than emit JSON.
 *
 * True unless the process looks like production — `NODE_ENV=production`, or a
 * deployed environment of `"prod"`. Pretty output is for a human at a terminal;
 * anything parsing logs wants the JSON.
 *
 * @param env - Environment to read from. Defaults to `process.env`.
 */
export function resolvePretty(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && resolveEnvironment(env) !== "prod";
}

const isDev = resolvePretty();

// pino level → Google Cloud Logging severity. Emitting `severity` lets Logs
// Explorer filter by level the same way across every app.
const GCP_SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

/**
 * Per-log enrichment: when an OpenTelemetry span is active, stamp the line with
 * its trace ids.
 *
 * Emits BOTH the raw OTel ids (`trace_id`/`span_id`) and Google Cloud's
 * `logging.googleapis.com/trace`, so Cloud Logging links each line to its trace.
 * No active span, or no SDK, returns nothing — the logger stays usable in
 * scripts and untraced contexts.
 */
function traceMixin(): Record<string, unknown> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  const fields: Record<string, unknown> = {
    trace_id: traceId,
    span_id: spanId,
  };
  if (gcpProject) {
    fields["logging.googleapis.com/trace"] =
      `projects/${gcpProject}/traces/${traceId}`;
    fields["logging.googleapis.com/spanId"] = spanId;
    fields["logging.googleapis.com/trace_sampled"] = (traceFlags & 1) === 1;
  }
  return fields;
}

// One shape for every app so Cloud Logging filters are uniform:
//   service (the app)   environment (dev/prod)   severity   message   trace ids
const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  messageKey: "message", // GCP shows this as the log summary
  base: { environment }, // replaces pid/hostname; every line carries the env
  formatters: {
    // emit GCP `severity` (and keep numeric `level` for pretty-printing).
    level(label, number) {
      return { severity: GCP_SEVERITY[label] ?? "DEFAULT", level: number };
    },
  },
  mixin: traceMixin,
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        messageKey: "message",
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    },
  }),
};

/**
 * A pino child logger labelled so lines can be filtered per service.
 *
 * Every line carries `service`, the active `environment`, a GCP-shaped
 * `severity`, and trace ids when a span is active. In Cloud Logging, filter by
 * `jsonPayload.service` for one service, `jsonPayload.service=~"worker-.*"` for
 * a group, or `jsonPayload.component` for a part of one.
 *
 * @param service - The service name. Keep it stable and predictable.
 * @param component - Optional finer label within a service.
 *
 * @example
 * ```ts
 * const log = createAppLogger("api", "checkout");
 * log.info({ orderId }, "order placed");
 * ```
 */
export function createAppLogger(
  service: string,
  component?: string
): PinoLogger {
  return pino(baseOptions).child(
    component ? { service, component } : { service }
  );
}

/**
 * The raw pino options behind {@link createAppLogger}.
 *
 * Pass to a framework that builds its own pino instance — Fastify's `logger`
 * option, for example — so its HTTP logs match the rest.
 *
 * @example
 * ```ts
 * const app = Fastify({ logger: loggerOptions });
 * ```
 */
export const loggerOptions = baseOptions;

export type Logger = PinoLogger;

/** How long `flushTelemetry()` waits before it gives up, in milliseconds. */
export const TELEMETRY_FLUSH_LIMIT_MS = 2000;

/**
 * What a flush came to:
 *
 * - `"flushed"`: telemetry was shut down and what it held was sent, or the
 *   attempt to send it failed (a failure is reported by the bootstrap, by its
 *   kind, and is not a reason to wait);
 * - `"timed_out"`: it did not finish within the limit;
 * - `"not_running"`: the bootstrap is not loaded or has no collector address,
 *   so there was nothing to flush.
 */
export type TelemetryFlush = "flushed" | "timed_out" | "not_running";

/**
 * Flush telemetry before the process exits. Call it LAST in an application's
 * own SIGTERM / SIGINT handler, after its in-flight work is done:
 *
 * ```ts
 * process.on("SIGTERM", async () => {
 *   await server.close();          // the application's own shutdown
 *   await flushTelemetry();        // then telemetry
 *   process.exit(0);
 * });
 * ```
 *
 * An application that registers a handler for a signal is the one that ends
 * the process: the bootstrap (`sgiant-observability/register`) then leaves
 * the signal alone, so that it cannot end the process in the middle of the
 * application's shutdown. This is the other half of that: without it, spans
 * still buffered when the process exits are lost.
 *
 * It NEVER rejects and NEVER keeps the process alive: it resolves when the
 * flush is done or when `limitMs` has passed, whichever is first, and its
 * timer does not hold the event loop open. After it resolves, telemetry is
 * shut down; spans created later are not recorded.
 *
 * @param limitMs - The longest to wait. Defaults to
 *   {@link TELEMETRY_FLUSH_LIMIT_MS}.
 */
export async function flushTelemetry(
  limitMs: number = TELEMETRY_FLUSH_LIMIT_MS
): Promise<TelemetryFlush> {
  const end = (globalThis as Record<symbol, unknown>)[
    Symbol.for("sgiant-observability.flush")
  ];
  if (typeof end !== "function") return "not_running";
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<TelemetryFlush>((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), limitMs);
    timer.unref();
  });
  const flushed = Promise.resolve()
    .then(() => (end as () => unknown)())
    .then(
      (): TelemetryFlush => "flushed",
      (err: unknown): TelemetryFlush => {
        // By kind, never the message: it can carry an address or a header.
        console.error(
          `[telemetry] flush failed (${err instanceof Error ? err.name : typeof err}); the process is not held for it`
        );
        return "flushed";
      }
    );
  try {
    return await Promise.race([flushed, limit]);
  } finally {
    clearTimeout(timer);
  }
}
