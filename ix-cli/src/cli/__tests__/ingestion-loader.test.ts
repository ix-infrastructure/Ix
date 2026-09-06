import { describe, expect, it } from "vitest";

import { isVmDynamicImportUnavailable } from "../commands/ingestion-loader.js";

/**
 * The loader reaches `ingestFiles` through `new Function("return import(...)")`
 * so the specifier stays invisible to bundlers. That indirection cannot run in
 * a `vm` context without an `importModuleDynamically` hook -- vitest's
 * vite-node being the one that matters -- so there is a fallback, and this
 * predicate is the gate on it. Get the gate wrong in either direction and the
 * damage is quiet: too narrow and `ingestFiles` is unloadable under vite-node
 * (which is how the whole commit path went untested through two rewrites); too
 * wide and a genuine module-not-found is swallowed and retried.
 *
 * Every error below is DERIVED from a real failure rather than written out by
 * hand. A hand-built `Error` with a plausible message and code proves only that
 * the predicate matches the shape its author already had in mind, which is the
 * shape it was written against -- so such a test passes whether or not the
 * predicate is right about the runtime.
 */
describe("isVmDynamicImportUnavailable", () => {
  /** The genuine article: run the loader's own indirection under vitest. */
  async function realVmFailure(): Promise<unknown> {
    try {
      await new Function("specifier", "return import(specifier);")("node:path");
      return null;
    } catch (err) {
      return err;
    }
  }

  it("matches the error vitest's vm context actually raises", async () => {
    const err = await realVmFailure();
    // If this is null the host gained a dynamic-import hook and the fallback is
    // no longer needed -- which is a real change worth failing on rather than
    // skipping past, because the whole fallback would then be dead code.
    expect(err, "expected the vm indirection to fail under vite-node").not.toBeNull();
    expect(isVmDynamicImportUnavailable(err)).toBe(true);
  });

  it("still matches once a module runner has rethrown it with its own code", async () => {
    // The regression this file exists for. An earlier revision matched `code`
    // OR the message as a ternary -- message only when `code` was absent --
    // which is narrower than the plain message test it replaced. Vite's module
    // runner rethrows the vm failure with `code: 'ERR_LOAD_URL'` and the
    // message preserved, so the wrapped error HAS a code, fails the prefix
    // test, never reaches the message test, and the fallback never fires on the
    // one host it is for.
    const original = (await realVmFailure()) as Error;
    const wrapped = new Error(original.message, { cause: original });
    (wrapped as NodeJS.ErrnoException).code = "ERR_LOAD_URL";

    expect(isVmDynamicImportUnavailable(wrapped)).toBe(true);
  });

  it("does not throw when the error carries a NUMERIC code", async () => {
    // `NodeJS.ErrnoException['code']` is typed as a string, but libuv-, zlib-
    // and OpenSSL-derived errors carry numbers. `code.startsWith` on one throws
    // a TypeError from inside the loader's catch block, replacing the real load
    // failure with an unrelated type error and discarding the original.
    const numeric = new Error("some unrelated failure");
    (numeric as unknown as { code: number }).code = -4058;

    expect(() => isVmDynamicImportUnavailable(numeric)).not.toThrow();
    expect(isVmDynamicImportUnavailable(numeric)).toBe(false);
  });

  it("does not match a genuine module-not-found", async () => {
    // The other direction, and the reason this cannot simply return true: a
    // real resolution failure must propagate, not be retried and reported
    // twice. Derived, again -- an actual failed import of a module that is not
    // there.
    let err: unknown = null;
    try {
      // Through a variable, so TypeScript does not try to resolve it at compile
      // time -- the point is a RUNTIME resolution failure.
      const missing = "./this-module-does-not-exist.js";
      await import(missing);
    } catch (caught) {
      err = caught;
    }

    expect(err, "expected the import to fail").not.toBeNull();
    expect(isVmDynamicImportUnavailable(err)).toBe(false);
  });
});
