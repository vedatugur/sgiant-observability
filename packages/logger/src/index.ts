import pino, { Logger as PinoLogger, LoggerOptions } from "pino";
import { context, trace } from "@opentelemetry/api";

const isDev = process.env.NODE_ENV !== "production";
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;
const environment =
  process.env.SGIANT_ENV ?? process.env.NODE_ENV ?? "development";

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
 * Per-log enrichment: when an OpenTelemetry span is active, stamp the log with
 * the trace IDs. We emit BOTH the raw OTel ids (trace_id/span_id) and Google
 * Cloud's `logging.googleapis.com/trace` field, so Cloud Logging links each log
 * line to its trace in Cloud Trace (one-click pivot). No span / no SDK → returns
 * nothing, so the logger stays usable in scripts and untraced contexts.
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
 * Returns a pino child logger labelled for filtering across all apps:
 *   service   — the app/worker (e.g. "api", "data-booking", "integration-sabee").
 *               Use the workspace package's short name so it's predictable.
 *   component — optional finer label within an app (e.g. "contact", "sync-once").
 *
 * Filter in Cloud Logging by `jsonPayload.service` (one app),
 * `jsonPayload.service=~"integration-.*"` (a whole group), or
 * `jsonPayload.component` (a sub-part). Use the same across Fastify + scripts.
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
 * Raw pino options — pass to Fastify so its HTTP logs share the same
 * pretty transport in dev and JSON output in prod.
 */
export const loggerOptions = baseOptions;

export type Logger = PinoLogger;
