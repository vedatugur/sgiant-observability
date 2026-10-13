const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

/**
 * WHO ENDS THE PROCESS WHEN IT IS TOLD TO STOP.
 *
 * The bootstrap used to register a SIGTERM handler that shut telemetry down
 * and called `process.exit(0)`, always. Signal handlers do not take turns, so
 * an application that had its own graceful shutdown (stop taking work, wait
 * for the work in hand, then exit) was ended a few milliseconds into its
 * wait: by its own telemetry library.
 *
 * Nothing found it for a long time, and the reason is the test's first rule:
 *
 *   THE BOOTSTRAP DOES NOTHING UNLESS A COLLECTOR ADDRESS IS SET.
 *
 * A process started with the preload and no `OTEL_EXPORTER_OTLP_ENDPOINT`
 * behaves perfectly, because the preload is inert. So every case here starts
 * a REAL process the way a deployment starts one: the preload in
 * NODE_OPTIONS and the address set. The address does not have to answer;
 * nothing listens at the one used here.
 *
 * These run against `dist/`, which is what a consumer installs.
 */

const ROOT = path.join(__dirname, "..");
const REGISTER = path.join(ROOT, "dist", "register.js");
const SERVICE = path.join(__dirname, "fixtures", "service.js");
/** A local port nothing listens on. */
const NO_COLLECTOR = "http://127.0.0.1:9";

/**
 * Start the stand-in service, wait until it says "ready", send `signal`
 * after `signalAfterMs`, and report how and when it ended and what it said.
 */
function run({
  mode,
  signal = "SIGTERM",
  signalAfterMs = 0,
  collector = NO_COLLECTOR,
  preload = true,
  env = {},
  giveUpAfterMs = 8000,
}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, MODE: mode, ...env };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
    // The test runner's own marker would make a child speak its wire format.
    delete childEnv.NODE_TEST_CONTEXT;
    if (preload) childEnv.NODE_OPTIONS = `--require ${REGISTER}`;
    if (collector) childEnv.OTEL_EXPORTER_OTLP_ENDPOINT = collector;
    // Only traces, as a deployment has it; nothing here depends on it.
    childEnv.OTEL_METRICS_EXPORTER = "none";
    childEnv.OTEL_LOGS_EXPORTER = "none";

    const child = spawn(process.execPath, [SERVICE], { env: childEnv });
    let out = "";
    let err = "";
    let signalledAt = 0;
    const aliveAt = [];
    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
    }, giveUpAfterMs);

    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      const first = !out.includes("ready");
      out += d;
      if (first && out.includes("ready")) {
        setTimeout(() => {
          signalledAt = Date.now();
          child.kill(signal);
          // Is it still running a little later? Signal 0 only asks.
          for (const after of [300, 700])
            setTimeout(() => {
              try {
                process.kill(child.pid, 0);
                aliveAt.push(after);
              } catch {
                /* gone */
              }
            }, after);
        }, signalAfterMs);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, bySignal) => {
      clearTimeout(giveUp);
      resolve({
        code,
        bySignal,
        tookMs: signalledAt ? Date.now() - signalledAt : null,
        aliveAt,
        said: out.split("\n").filter(Boolean),
        err,
      });
    });
  });
}

test("a service with its OWN shutdown is not ended by the bootstrap: it waits for its work, flushes, and ends itself", async () => {
  const r = await run({ mode: "own", env: { WAIT_MS: "1500" } });
  assert.deepEqual(
    r.said,
    [
      "handler-registered",
      "ready",
      "waiting SIGTERM",
      "work-done",
      "flush flushed",
    ],
    r.err
  );
  // Still running well after the signal: this is what used to fail. The
  // process was gone within milliseconds of "waiting".
  assert.deepEqual(r.aliveAt, [300, 700]);
  assert.ok(r.tookMs >= 1400, `ended after ${r.tookMs} ms, before its work`);
  assert.equal(r.code, 0);
  assert.equal(r.bySignal, null);
});

test("the same for SIGINT", async () => {
  const r = await run({ mode: "own", signal: "SIGINT", env: { WAIT_MS: "900" } });
  assert.deepEqual(r.said.slice(2), [
    "waiting SIGINT",
    "work-done",
    "flush flushed",
  ]);
  assert.ok(r.tookMs >= 800);
  assert.equal(r.code, 0);
});

test("a service with NO shutdown of its own is still ended by the bootstrap, promptly, with exit code 0", async () => {
  const r = await run({ mode: "none" });
  assert.deepEqual(r.said, ["ready"]);
  // Ended by the bootstrap (code 0), not killed by the signal's default.
  assert.equal(r.code, 0, r.err);
  assert.equal(r.bySignal, null);
  assert.ok(r.tookMs < 2500, `took ${r.tookMs} ms to stop`);
});

test("a service signalled DURING START-UP, before it has registered its handler, is ended promptly and is not left running", async () => {
  // It would register a handler after three seconds; it is signalled at once.
  const r = await run({ mode: "late", env: { START_MS: "3000" } });
  assert.deepEqual(r.said, ["ready"], "it must not have got as far as its handler");
  assert.equal(r.code, 0, r.err);
  assert.ok(r.tookMs < 2500, `took ${r.tookMs} ms to stop`);
});

test("judged when the signal ARRIVES: the same service, signalled after it registered its handler, ends itself", async () => {
  const r = await run({
    mode: "late",
    signalAfterMs: 600,
    env: { START_MS: "200", WAIT_MS: "800" },
  });
  assert.deepEqual(r.said, [
    "ready",
    "handler-registered",
    "waiting SIGTERM",
    "work-done",
    "flush flushed",
  ]);
  assert.ok(r.tookMs >= 700);
  assert.equal(r.code, 0);
});

test("the bootstrap has no timer of its own: a service whose handler never ends the process is left to its supervisor", async () => {
  // Nothing in this package may cut an application's shutdown short. The
  // supervisor's stop timeout is the backstop; here the test plays it.
  const r = await run({ mode: "never", giveUpAfterMs: 3000 });
  assert.deepEqual(r.said, ["handler-registered", "ready", "waiting SIGTERM"]);
  assert.deepEqual(r.aliveAt, [300, 700]);
  assert.equal(r.bySignal, "SIGKILL", "something ended it before the supervisor did");
  const src = readFileSync(path.join(ROOT, "src", "register.ts"), "utf8");
  assert.doesNotMatch(src, /setTimeout|setInterval/);
});

test("WITHOUT a collector address the bootstrap is inert, which is why a test without one proves nothing", async () => {
  // No handlers are registered at all: the signal's default ends the process.
  const none = await run({ mode: "none", collector: null });
  assert.equal(none.bySignal, "SIGTERM");
  assert.equal(none.code, null);
  // And a service with its own shutdown works, as it always did here:
  // exactly the result that hid the fault.
  const own = await run({ mode: "own", collector: null, env: { WAIT_MS: "500" } });
  assert.deepEqual(own.said.slice(2), [
    "waiting SIGTERM",
    "work-done",
    "flush not_running",
  ]);
});

test("flushTelemetry never rejects and never holds the process: done, timed out, failed, or nothing to flush", async () => {
  const { flushTelemetry, TELEMETRY_FLUSH_LIMIT_MS } = require("../dist/index.js");
  const KEY = Symbol.for("sgiant-observability.flush");
  const before = globalThis[KEY];
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.equal(TELEMETRY_FLUSH_LIMIT_MS, 2000);

    delete globalThis[KEY];
    assert.equal(await flushTelemetry(), "not_running");

    globalThis[KEY] = async () => {};
    assert.equal(await flushTelemetry(), "flushed");

    // One that never finishes: given up on at the limit.
    globalThis[KEY] = () => new Promise(() => {});
    const started = Date.now();
    assert.equal(await flushTelemetry(150), "timed_out");
    const took = Date.now() - started;
    assert.ok(took >= 140 && took < 1000, `gave up after ${took} ms`);

    // One that fails, or throws at once: reported by its KIND, not thrown,
    // and nothing of its message printed.
    const secret = "https://collector.internal/v1/traces?key=abc";
    for (const failing of [
      async () => {
        throw new TypeError(secret);
      },
      () => {
        throw new RangeError(secret);
      },
    ]) {
      globalThis[KEY] = failing;
      assert.equal(await flushTelemetry(), "flushed");
    }
    assert.equal(logged.length, 2);
    assert.match(logged[0], /flush failed \(TypeError\)/);
    assert.match(logged[1], /flush failed \(RangeError\)/);
    for (const line of logged) assert.ok(!line.includes("collector.internal"));
  } finally {
    console.error = realError;
    if (before === undefined) delete globalThis[KEY];
    else globalThis[KEY] = before;
  }
});

test("the two entry points still do not import each other: the flush is reached through a global symbol", () => {
  const index = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  const register = readFileSync(path.join(ROOT, "src", "register.ts"), "utf8");
  const key = /Symbol\.for\("sgiant-observability\.flush"\)/;
  assert.match(index, key);
  assert.match(register, key);
  assert.doesNotMatch(index, /from\s+["']\.\/register["']/);
  assert.doesNotMatch(register, /from\s+["']\.\/index["']/);
});
