/**
 * Shared OpenTelemetry bootstrap for every backend Node service (API + workers).
 *
 * THIS FILE MUST NOT IMPORT `./index`, AND `./index` MUST NOT IMPORT THIS FILE.
 * `#328` merged the logger and the tracer into one package, which is right —
 * they are one concern — but it put the two halves within an import of each
 * other for the first time. The auto-instrumentations patch pino by
 * intercepting its module load, so pino must not be loaded until after
 * `sdk.start()`. One import in either direction would load it first, and the
 * only symptom would be log lines that quietly stop carrying trace ids: nothing
 * crashes, nothing warns, and the correlation this package exists to provide is
 * simply gone. `tests/unit/observability-entry-points.test.ts` asserts the two
 * files stay disjoint.
 *
 * Load it FIRST, before the app imports http/fastify/pg, via:
 *   NODE_OPTIONS="--require /repo/packages/observability/dist/register.js"
 * (set per service in infra/docker/compose.yaml). Each service sets its own
 * OTEL_SERVICE_NAME so traces are attributable per app.
 *
 * Exports OTLP traces to the in-stack OTel Collector (OTEL_EXPORTER_OTLP_ENDPOINT),
 * which forwards to Google Cloud Trace. If the endpoint is unset (local dev),
 * this is a no-op — the service runs without telemetry.
 *
 * Trace↔log correlation is automatic: instrumentation-pino stamps trace ids on
 * each log line and @sgiant/observability adds Google Cloud's trace field on top.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs spans are extremely noisy and rarely useful.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });
    sdk.start();

    const shutdown = () => {
      sdk
        .shutdown()
        .catch(() => {})
        .finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    // Never let telemetry setup crash the service.

    console.error("[telemetry] init failed, continuing without it:", err);
  }
}
