const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveEnvironment, resolvePretty } = require("../dist/index.js");

/**
 * WHICH ENVIRONMENT A BOX THINKS IT IS IN, and whether it prints for humans.
 *
 * Moved here from sgiant-platform when this package finished leaving that repo
 * (#152). It had been reaching into `packages/observability/src`, which stopped
 * existing — and the property is this package's, not the platform's, so it
 * belongs with the code rather than with one of its consumers.
 *
 * It runs against `dist/` on purpose: that is what every consumer installs, and
 * the platform's copy tested `src/`. A build that dropped an export would have
 * passed there and failed for real.
 *
 * #282, the incident it exists for: the prod agent VM logged
 * `environment: "development"` on the SAME line where the gateway's own config
 * logged `env: "prod"`. Two provisioning paths write two different names — the
 * app VM writes SGIANT_ENV (a manifest key), provision-agent-vm.sh writes
 * APP_ENV — and the logger knew only the first.
 */

test("APP_ENV names the environment when SGIANT_ENV is absent (the agent VM)", () => {
  assert.equal(resolveEnvironment({ APP_ENV: "prod" }), "prod");
  assert.equal(resolveEnvironment({ APP_ENV: "dev" }), "dev");
});

test("SGIANT_ENV wins over APP_ENV and NODE_ENV (the app VM)", () => {
  assert.equal(
    resolveEnvironment({
      SGIANT_ENV: "prod",
      APP_ENV: "dev",
      NODE_ENV: "development",
    }),
    "prod"
  );
});

test("NODE_ENV is the last resort, and an empty env still names something", () => {
  assert.equal(resolveEnvironment({ NODE_ENV: "production" }), "production");
  assert.equal(resolveEnvironment({}), "development");
});

// The more expensive half of #282: NODE_ENV is unset on the agent VM, so
// `NODE_ENV !== "production"` was true and pino-pretty replaced the structured
// JSON with colourised text. The formatter emits GCP `severity`; the transport
// then threw it away, so prod agent lines arrived unqueryable.
test("a box that APP_ENV calls prod does not pretty-print", () => {
  assert.equal(resolvePretty({ APP_ENV: "prod" }), false);
});

// Kept as a strict NARROWING: anything that already set NODE_ENV must behave
// exactly as it did before, or this fix quietly restyles the dev VM's logs.
test("an explicit NODE_ENV=production still disables pretty-printing", () => {
  assert.equal(
    resolvePretty({ NODE_ENV: "production", SGIANT_ENV: "dev" }),
    false
  );
});

test("dev boxes and local runs keep pretty-printing", () => {
  assert.equal(resolvePretty({ APP_ENV: "dev" }), true);
  assert.equal(resolvePretty({ SGIANT_ENV: "dev" }), true);
  assert.equal(resolvePretty({}), true);
});
