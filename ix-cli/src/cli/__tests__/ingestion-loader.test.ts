// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, expectTypeOf, it } from "vitest";
import type * as CoreIngestion from "@ix/core-ingestion";
import type * as CorePatchBuilder from "@ix/core-ingestion/patch-builder";
import type * as CoreLanguages from "@ix/core-ingestion/languages";

import { isVmDynamicImportUnavailable, loadIngestionModules } from "../commands/ingestion-loader.js";

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
    // Guarded for the same reason test 1 asserts it: if the host ever gains a
    // dynamic-import hook this is `null`, and `original.message` would fail
    // with an opaque TypeError instead of naming the cause.
    expect(original, "expected the vm indirection to fail under vite-node").not.toBeNull();
    const wrapped = new Error(original.message, { cause: original });
    (wrapped as NodeJS.ErrnoException).code = "ERR_LOAD_URL";

    expect(isVmDynamicImportUnavailable(wrapped)).toBe(true);
  });

  it("matches on the CODE alone, when the message no longer says anything", async () => {
    // The case that makes the code check load-bearing. The real error carries
    // BOTH a matching code and a matching message, so `||` short-circuits on
    // the message and the code clause is never reached: deleting it left this
    // file 4/4 green. That is not a hypothetical gap -- a later "simplification"
    // back to a message-only match is exactly the pre-#613 form, ships green,
    // and then Node rewords the message and the fallback silently stops firing.
    //
    // Derived, like the others: the real error with its real code, and only the
    // message replaced.
    const original = (await realVmFailure()) as Error;
    expect(original, "expected the vm indirection to fail under vite-node").not.toBeNull();
    // The premise, asserted rather than assumed -- every other test here does
    // the same. Without it, the day vite-node wraps this failure under its
    // own code (which is precisely why test 2 exists) or Node renames it, this
    // fails as a bare `expected false to be true` pointing at the predicate,
    // when what changed is the input.
    // `typeof` as well as the value, because the predicate demands a STRING
    // `code` before it calls `startsWith`. Asserting only `String(code)`
    // passes on a non-string that stringifies the same way -- exactly the
    // shape the NUMERIC-code test below exists for -- and the failure would
    // then land two lines down as a bare `expected false to be true` against
    // the predicate, which is the confusion this premise assertion is here to
    // prevent.
    expect(
      typeof (original as NodeJS.ErrnoException).code,
      "the predicate reads `code` only when it is a string",
    ).toBe("string");
    expect(
      String((original as NodeJS.ErrnoException).code),
      "the real vm failure still carries the vm code",
    ).toMatch(/^ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/);

    const reworded = new Error("the wording of this error changed upstream");
    (reworded as NodeJS.ErrnoException).code = (original as NodeJS.ErrnoException).code;

    // `String(reworded)`, which is what the predicate inspects -- not
    // `.message`, which is what an earlier version checked. They differ by the
    // error's name prefix, so a fixture that ever carried the phrase in its
    // NAME would satisfy the message clause while this assertion still passed,
    // and this test would go green without the code clause -- silently
    // reopening the gap it exists to close.
    expect(String(reworded)).not.toMatch(/dynamic import callback/i);
    expect(isVmDynamicImportUnavailable(reworded)).toBe(true);
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

/**
 * The boundary between this package and core-ingestion is typed by the
 * library's own declarations (#953). The CLI used to describe the three modules
 * with hand-written, all-`any` signatures that had drifted from the library --
 * `resolveEdges` with three parameters to the library's four,
 * `buildPatchWithResolution` without `multiRepo` and `resolutionSalt` -- so a
 * change on either side compiled and broke at run time.
 *
 * The `expectTypeOf` and `@ts-expect-error` lines are checked by
 * `npm run typecheck`, not by vitest: if the loader's types go back to `any`
 * (or to a hand copy), those are what fail.
 */
describe("loadIngestionModules", () => {
  type Loaded = Awaited<ReturnType<typeof loadIngestionModules>>;

  it("is typed by core-ingestion's own declarations", () => {
    expectTypeOf<Loaded[0]>().toEqualTypeOf<typeof CoreIngestion>();
    expectTypeOf<Loaded[1]>().toEqualTypeOf<typeof CorePatchBuilder>();
    expectTypeOf<Loaded[2]>().toEqualTypeOf<typeof CoreLanguages>();
    expectTypeOf<Loaded[0]["resolveEdges"]>().not.toBeAny();
    expectTypeOf<Loaded[1]["buildPatchWithResolution"]>().not.toBeAny();
  });

  it("rejects a call the library does not accept", () => {
    // Never called: these exist only for the type checker.
    const check = (ingestion: Loaded[0], patchBuilder: Loaded[1], parsed: CoreIngestion.FileParseResult) => {
      // @ts-expect-error -- resolveEdges takes parse results, not paths
      ingestion.resolveEdges(["src/a.ts"]);
      // @ts-expect-error -- the resolved edges are required
      patchBuilder.buildPatchWithResolution(parsed, "hash", "ws");
    };
    expect(typeof check).toBe("function");
  });

  it("loads the built modules the types describe", async () => {
    const [ingestion, patchBuilder, languages] = await loadIngestionModules();
    // The functions ingest calls through the typed handles. A declaration with
    // no export behind it would type-check and fail here.
    for (const fn of [
      ingestion.parseFile, ingestion.resolveEdges, ingestion.summarizeParseResult,
      ingestion.buildGlobalResolutionIndex, ingestion.isGrammarSupported,
      patchBuilder.buildPatchWithResolution, patchBuilder.buildDeletionPatch,
      patchBuilder.sourcePatchIdCandidates, patchBuilder.fileNodeId,
      patchBuilder.symbolNodeId, patchBuilder.extractorName,
      languages.languageFromPath,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(Array.isArray(patchBuilder.PREVIOUS_EXTRACTORS)).toBe(true);
  });
});
