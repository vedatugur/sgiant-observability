const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

/**
 * This package has two entry points, and the separation between them is
 * load-bearing.
 *
 * `register.ts` starts the OpenTelemetry SDK, whose auto-instrumentations patch
 * libraries by intercepting their module load. pino is one of them. So pino must
 * not be loaded until after `sdk.start()` — which is why `register` is a
 * NODE_OPTIONS preload rather than something you import.
 *
 * A single import between the two files would load pino first. Nothing crashes
 * and nothing warns; the log lines just stop carrying trace ids, and the
 * trace-to-log correlation this package exists to provide is gone with no signal
 * at all. That is the exact shape of failure a test has to cover, because no
 * runtime check ever will.
 *
 * Read as TEXT, not imported: importing them here would itself load pino, and
 * the point is to check the source, not to run it.
 */
describe("entry points", () => {
  const index = readFileSync("src/index.ts", "utf8");
  const register = readFileSync("src/register.ts", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  it("the logger never pulls in the tracer bootstrap", () => {
    assert.doesNotMatch(
      index,
      /from\s+["']\.\/register["']|require\(["']\.\/register["']\)/,
      "index.ts imports ./register — that runs the SDK bootstrap at logger " +
        "import time, which is too late to patch anything"
    );
  });

  it("the tracer bootstrap never pulls in the logger", () => {
    assert.doesNotMatch(
      register,
      /from\s+["']\.\/index["']|require\(["']\.\/index["']\)|from\s+["']\.["']/,
      "register.ts imports the logger — that loads pino before sdk.start(), " +
        "so instrumentation-pino cannot patch it and logs lose their trace ids"
    );
  });

  it("both entry points are declared, with types", () => {
    // An earlier version of the tracer shipped a `main` and an `exports` path
    // with no `types` at all, so it had a declaration file nothing verified.
    for (const path of [".", "./register"]) {
      assert.ok(pkg.exports[path], `exports["${path}"] is missing`);
      assert.ok(
        pkg.exports[path].types,
        `exports["${path}"].types is missing — the entry ships untyped`
      );
    }
  });

  it("pino-pretty is a runtime dependency, not a dev one", () => {
    // createAppLogger passes `transport: { target: "pino-pretty" }`, which pino
    // resolves BY SPECIFIER at runtime. No static import names it, so a
    // devDependency works for whoever wrote it (hoisted into node_modules) and
    // throws `unable to determine transport target` for everyone who installs
    // the published package. It was found exactly that way.
    assert.ok(
      pkg.dependencies["pino-pretty"],
      "pino-pretty must be a dependency: it is loaded by specifier at runtime"
    );
  });
});
