/**
 * The logging half of `sgiant-observability` — the `.` entry point.
 *
 * Do NOT import `./register` from here. See the comment at the top of that file:
 * it has to run before pino is loaded, and an import from this side would defeat
 * it silently. `tests/unit/observability-entry-points.test.ts` enforces it.
 */
import pino, { Logger as PinoLogger, LoggerOptions } from "pino";
import { context, trace } from "@opentelemetry/api";

const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;

/**
 * The deployed environment, resolved from the first of THREE names that is set.
 * Three, because two provisioning paths write two different names and this file
 * knew only one of them:
 *
 *   - `SGIANT_ENV` — the app VM. A key in infra/env-profiles/manifest.mjs, so
 *     every generated app-env carries it.
 *   - `APP_ENV`    — the AGENT VM. provision-agent-vm.sh:167 writes it, and that
 *     box's env file is NOT generated from the manifest, so `SGIANT_ENV` is
 *     never set there.
 *   - `NODE_ENV`   — the local fallback.
 *
 * Measured on the prod agent VM, 2026-08-28 (#282): every journal line read
 * `environment: "development"` while the gateway's own config, on that SAME
 * line, read `env: "prod"`. apps/agent-gateway/src/config.ts already resolved
 * `APP_ENV`; this file did not, so one process disagreed with itself. Anyone
 * filtering logs by environment looked for prod lines in the dev bucket.
 */
export function resolveEnvironment(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.SGIANT_ENV ?? env.APP_ENV ?? env.NODE_ENV ?? "development";
}

const environment = resolveEnvironment();

/**
 * Pretty-printing is for a human at a terminal, and it was silently ON in prod
 * on the agent VM — the same root cause, and the more expensive half. `NODE_ENV`
 * is unset on that box, so `!== "production"` was true, and pino-pretty replaced
 * the structured JSON with colourised text. Those prod lines reached Cloud
 * Logging with no parseable `severity` and no queryable fields at all: the
 * formatter below carefully emits GCP severity, and the transport then threw it
 * away.
 *
 * The `NODE_ENV` test is KEPT rather than replaced so this stays a strict
 * narrowing: every environment that already set `NODE_ENV` behaves exactly as
 * before (a dev container with `NODE_ENV=production` keeps its JSON logs). The
 * added clause only catches the case that had no answer — `NODE_ENV` unset on a
 * box that `APP_ENV` says is prod.
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
