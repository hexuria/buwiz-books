import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

/**
 * Guards a bug class that cost real debugging time and would otherwise recur on every dependency
 * bump: a `patchedDependencies` entry silently going inert.
 *
 * `bun` keys patches by exact version. When `@tanstack/start-server-core` moved 1.167.19 → 1.169.17
 * the key in package.json kept pointing at the old version, so `bun install` simply stopped
 * applying the patch — no warning, no error, no lockfile complaint. Nothing in `bun check`, the
 * type system or the test suite noticed.
 *
 * What the patch prevents matters more than it looks. Without it, `handleServerAction`
 * dereferences `action.method` when `getServerFnById` returns undefined (which happens routinely
 * in dev while Vite re-optimises), Nitro turns the resulting TypeError into a 500 whose body is
 * JSON, and Start's client — which only unwraps its `{ result, error }` envelope when the
 * response carries `x-tss-serialized` — hands that error body to the middleware chain as a
 * context patch. Both `result` and `error` come out undefined, so the server function *resolves*
 * to `undefined` instead of rejecting. Combined with `const { data: rows = [] } = useQuery(...)`
 * at the call sites, a transport failure renders as "you have no accounts".
 *
 * `callServerFn` in src/lib/server-fn-client.ts is the load-bearing defence against that (it
 * turns the undefined back into a rejection, in production too). This file guards the second
 * layer — and, more importantly, guards the *mechanism* by which the first defence was lost.
 */
describe("start-server-core patch wiring", () => {
  const pkg = JSON.parse(read("package.json")) as {
    patchedDependencies?: Record<string, string>;
  };

  const PACKAGE = "@tanstack/start-server-core";
  const entries = Object.entries(pkg.patchedDependencies ?? {});
  const entry = entries.find(([key]) => key.startsWith(`${PACKAGE}@`));

  it("declares a patch for start-server-core", () => {
    expect(entry, `expected a patchedDependencies entry for ${PACKAGE}`).toBeDefined();
  });

  it("keys the patch to the version actually installed", () => {
    const [key] = entry!;
    const declared = key.slice(`${PACKAGE}@`.length);

    const installed = (
      JSON.parse(read(`node_modules/${PACKAGE}/package.json`)) as { version: string }
    ).version;

    // This is the assertion that would have caught the original failure.
    expect(
      declared,
      `package.json patches ${PACKAGE}@${declared} but ${installed} is installed — bun keys ` +
        `patches by exact version, so the patch is being silently skipped. Rename ` +
        `patches/ to match and re-run \`bun install\`.`,
    ).toBe(installed);
  });

  it("points at a patch file that exists", () => {
    const [, patchPath] = entry!;
    expect(existsSync(resolve(REPO_ROOT, patchPath)), `${patchPath} is missing`).toBe(true);
  });

  it("has actually been applied to node_modules", () => {
    // The outcome, not the config — the only check that cannot be fooled by a correct-looking
    // package.json that `bun install` never acted on.
    const handler = read(`node_modules/${PACKAGE}/dist/esm/server-functions-handler.js`);

    expect(
      handler,
      "the start-server-core patch is declared but not present in node_modules — run `bun install`",
    ).toContain("Vite HMR Optimization Reload in progress");

    // And the guard must still sit ahead of the unchecked dereference it exists to prevent.
    const guardAt = handler.indexOf("Vite HMR Optimization Reload in progress");
    const derefAt = handler.indexOf("action.method");
    expect(guardAt).toBeGreaterThan(-1);
    expect(
      derefAt,
      "the `if (!action)` guard must precede the `action.method` dereference it protects",
    ).toBeGreaterThan(guardAt);
  });
});

/**
 * The transport guard itself. Cheap to assert, and the comment above explains why losing it is
 * expensive: in accounting software a silent empty ledger is worse than a loud failure.
 */
describe("server function transport guard", () => {
  const source = read("src/lib/server-fn-client.ts");

  it("rejects rather than resolves when a server function yields undefined", () => {
    expect(source).toMatch(/result === undefined/);
    expect(source).toMatch(/throw new Error/);
  });

  it("is not a bare passthrough", () => {
    // The original `return fn(opts)` is what let every call site inherit the silent failure.
    expect(source).not.toMatch(/^\s*return fn\(opts\);\s*$/m);
  });
});
