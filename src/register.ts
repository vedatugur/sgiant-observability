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
 *
 * ## Who ends the process on SIGTERM / SIGINT
 *
 * A preload that exits on SIGTERM ends the process before the application's
 * own graceful shutdown has run. Signal handlers do not take turns: this file
 * registers first, so its `process.exit()` won the race every time, and a
 * service that had just started waiting for its in-flight work was gone a few
 * milliseconds later.
 *
 * So the rule is: **the application ends its own process when it has a
 * handler for the signal; this file ends it only when nobody else will.**
 *
 * - The application has registered NO handler of its own for the signal:
 *   telemetry is shut down (which flushes it) and the process exits `0`, as
 *   before. A service with nothing to wait for still stops promptly.
 * - The application HAS one: this file does nothing on the signal. Telemetry
 *   keeps recording while the application finishes its work, and the
 *   application calls `flushTelemetry()` (exported from the package's main
 *   entry) before it exits.
 *
 * "Has one" is judged WHEN THE SIGNAL ARRIVES, not at load: a service
 * registers its handler some time after this file ran. A service signalled
 * during start-up, before it registered anything, is therefore ended here,
 * promptly, rather than left running with no one to end it.
 *
 * There is deliberately NO timer here. If an application's handler never
 * lets the process end, the supervisor's own stop timeout (for a container,
 * its stop grace period) is the backstop. A timer in this file would be a
 * second place that can cut an application's shutdown short.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

/** An error's class name: safe to print where its message is not. */
function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

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

    // Shut down ONCE, however many callers ask: a second `sdk.shutdown()`
    // is an error in the SDK, and both a signal and the application may ask.
    // A failure is reported by its kind only, and never thrown: an error's
    // message can carry an address or a header.
    let ended: Promise<void> | undefined;
    const end = (): Promise<void> =>
      (ended ??= sdk.shutdown().catch((err: unknown) => {
        console.error(
          `[telemetry] shutdown failed (${errorKind(err)}); the process is not held for it`
        );
      }));

    // How the main entry reaches this without importing this file (see the
    // header: an import in either direction loads pino too early). A symbol
    // from the global registry is the same value in both files.
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("sgiant-observability.flush")
    ] = end;

    const onSignal = (signal: "SIGTERM" | "SIGINT") => (): void => {
      // This handler is one listener. Another means the application has its
      // own shutdown for this signal, and ends the process itself.
      if (process.listenerCount(signal) > 1) return;
      void end().finally(() => process.exit(0));
    };
    process.on("SIGTERM", onSignal("SIGTERM"));
    process.on("SIGINT", onSignal("SIGINT"));
  } catch (err) {
    // Never let telemetry setup crash the service.

    console.error("[telemetry] init failed, continuing without it:", err);
  }
}
