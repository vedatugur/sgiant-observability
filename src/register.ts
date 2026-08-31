/**
 * OpenTelemetry bootstrap for a Node service. Side effect only — no exports.
 *
 * Load it FIRST, before the app imports http/fastify/pg, or the
 * auto-instrumentations have nothing to patch:
 *
 *   NODE_OPTIONS="--require sgiant-observability/register"
 *
 * Set `OTEL_SERVICE_NAME` per service so traces are attributable, and
 * `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector. With the endpoint unset this
 * is a no-op and the service runs untraced — which is the intended local
 * default, not a failure.
 *
 * Never import `./index` from here, or this file from `./index`. The
 * auto-instrumentations patch pino by intercepting its module load, so pino
 * must not load until after `sdk.start()`. One import in either direction loads
 * it first, and the only symptom is log lines that quietly stop carrying trace
 * ids: nothing crashes and nothing warns.
 *
 * Init failures are swallowed — telemetry must never take a service down.
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
