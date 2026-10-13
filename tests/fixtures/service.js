// A stand-in for a service, started by graceful-stop.test.js with the
// bootstrap preloaded exactly as a deployment preloads it.
//
//   MODE=none   no shutdown of its own
//   MODE=own    its own SIGTERM/SIGINT handler: waits WAIT_MS for "work in
//               hand", flushes telemetry, exits
//   MODE=late   registers that handler only after START_MS of start-up
//   MODE=never  its own handler, which never ends the process
//
// It says what it does on stdout, one word per line, so the test can read
// the order of events.
const { flushTelemetry } = require("../../dist/index.js");

const mode = process.env.MODE || "none";
const waitMs = Number(process.env.WAIT_MS || 1500);
const startMs = Number(process.env.START_MS || 0);

// Something to keep the process alive, as a listening server would.
const alive = setInterval(() => {}, 1000);

const ownShutdown = (signal) => async () => {
  console.log(`waiting ${signal}`);
  if (mode === "never") return;
  await new Promise((r) => setTimeout(r, waitMs));
  console.log("work-done");
  const flush = await flushTelemetry();
  console.log(`flush ${flush}`);
  clearInterval(alive);
  process.exit(0);
};

const register = () => {
  process.on("SIGTERM", ownShutdown("SIGTERM"));
  process.on("SIGINT", ownShutdown("SIGINT"));
  console.log("handler-registered");
};

if (mode === "own" || mode === "never") register();
if (mode === "late") setTimeout(register, startMs);

console.log("ready");
