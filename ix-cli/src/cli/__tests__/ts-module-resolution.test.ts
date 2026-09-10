// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTypeScriptModuleResolver } from "../ts-module-resolution.js";

const workspaces: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ix-ts-resolution-"));
  workspaces.push(root);
  return root;
}

function write(root: string, relativePath: string, content = ""): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createTypeScriptModuleResolver", () => {
  it("resolves tsconfig paths before an unrelated same-stem file", () => {
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      `{
      // JSONC comments and trailing commas are valid in tsconfig files.
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@core": ["src/adapters/worker"], },
      },
    }`,
    );
    const consumer = write(root, "src/consumer.ts");
    const worker = write(root, "src/adapters/worker.ts");
    const unrelated = write(root, "legacy/core.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, worker, unrelated]);

    expect(resolve("src/consumer.ts", "@core")).toEqual(["src/adapters/worker.ts"]);
  });

  it("treats an unresolved matching paths rule as authoritative", () => {
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@core/*": ["src/core/*"] } },
      }),
    );
    const consumer = write(root, "src/consumer.ts");
    const unrelated = write(root, "legacy/missing.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, unrelated]);

    expect(resolve("src/consumer.ts", "@core/missing")).toEqual([]);
  });

  it("substitutes wildcard text without interpreting replacement tokens", () => {
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@core/*": ["src/core/*"] } },
      }),
    );
    const consumer = write(root, "src/consumer.ts");
    const target = write(root, "src/core/$&.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, target]);

    expect(resolve("src/consumer.ts", "@core/$&")).toEqual(["src/core/$&.ts"]);
  });

  it("resolves baseUrl modules", () => {
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: "src" },
      }),
    );
    const consumer = write(root, "src/consumer.ts");
    const worker = write(root, "src/services/worker.ts");
    const unrelated = write(root, "vendor/worker.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, worker, unrelated]);

    expect(resolve("src/consumer.ts", "services/worker")).toEqual(["src/services/worker.ts"]);
  });

  it("does not treat an unresolved baseUrl module as authoritative", () => {
    // `baseUrl` matches every bare specifier, so its miss carries no information.
    // Returning [] here tells the resolver "definitively not local", which drops
    // the edge; `undefined` means "no opinion" and lets the stem fallback run.
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: "src" },
      }),
    );
    const consumer = write(root, "src/consumer.ts");
    const unrelated = write(root, "legacy/missing.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, unrelated]);

    expect(resolve("src/consumer.ts", "services/missing")).toBeUndefined();
  });

  it("keeps third-party specifiers unresolved rather than authoritative under baseUrl", () => {
    // The regression this guards: `baseUrl: "."` is the default in Next.js, CRA
    // and most monorepo templates. Claiming authority over `react` there erased
    // every third-party import edge in the graph.
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: "." } }),
    );
    const consumer = write(root, "packages/app/index.ts");
    const sibling = write(root, "packages/lib/index.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, sibling]);

    expect(resolve("packages/app/index.ts", "react")).toBeUndefined();
    expect(resolve("packages/app/index.ts", "@org/lib")).toBeUndefined();
  });

  it("does not treat a catch-all paths rule as authoritative", () => {
    // `"*": ["src/*"]` matches every specifier, so it is baseUrl by another name.
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "*": ["src/*"] } },
      }),
    );
    const consumer = write(root, "src/consumer.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer]);

    expect(resolve("src/consumer.ts", "lodash")).toBeUndefined();
  });

  it("falls back to baseUrl when a matching paths rule resolves nothing", () => {
    // TypeScript tries `paths` first, then `baseUrl`. A failed rule must not
    // short-circuit the baseUrl lookup.
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: "src", paths: { "@core/*": ["missing/*"] } },
      }),
    );
    const consumer = write(root, "src/consumer.ts");
    const actual = write(root, "src/@core/thing.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, actual]);

    expect(resolve("src/consumer.ts", "@core/thing")).toEqual(["src/@core/thing.ts"]);
  });

  it("ignores a config larger than the size cap instead of parsing it", () => {
    // The resolver is built before ingestion's MAX_FILE_BYTES gate, so a repo
    // could hand it a 64 MB JSONC file and take the process out with an
    // uncatchable OOM. Small here; the cap is what is under test.
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      `{/*${"a".repeat(1024 * 1024 + 16)}*/"compilerOptions":{"paths":{"@core":["src/worker"]}}}`,
    );
    const consumer = write(root, "src/consumer.ts");
    const worker = write(root, "src/worker.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, worker]);

    // Config ignored entirely -> no mapping, and no opinion.
    expect(resolve("src/consumer.ts", "@core")).toBeUndefined();
  });

  it("refuses an extends that escapes the workspace", () => {
    // `startsWith(".")` is not containment: resolve() clamps at the filesystem
    // root, so enough `..` segments name any absolute path.
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), "ix-outside-"));
    workspaces.push(outside);
    writeFileSync(
      join(outside, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@evil": ["target"] } } }),
    );
    const escape = relative(root, join(outside, "tsconfig.json")).split(sep).join("/");
    const config = write(root, "tsconfig.json", JSON.stringify({ extends: `./${escape}` }));
    const consumer = write(root, "src/consumer.ts");
    const target = write(root, "target.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, target]);

    expect(resolve("src/consumer.ts", "@evil")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses an extends that leaves the workspace through a symlinked directory",
    () => {
      // Every segment of "./linked/tsconfig.json" is inside the workspace by
      // path arithmetic, so a lexical containment check passes it. Only the
      // path we actually opened shows that `linked/` is a link to elsewhere.
      const root = workspace();
      const outside = mkdtempSync(join(tmpdir(), "ix-outside-"));
      workspaces.push(outside);
      writeFileSync(
        join(outside, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { paths: { "@evil": ["target"] } } }),
      );
      try {
        symlinkSync(outside, join(root, "linked"), "dir");
      } catch {
        return; // no permission to symlink (e.g. restricted CI) — nothing to assert
      }
      const config = write(root, "tsconfig.json", JSON.stringify({ extends: "./linked/tsconfig.json" }));
      const consumer = write(root, "src/consumer.ts");
      const target = write(root, "target.ts");
      const resolve = createTypeScriptModuleResolver(root, [config, consumer, target]);

      expect(resolve("src/consumer.ts", "@evil")).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "still resolves when the workspace root is itself reached through a symlink",
    () => {
      // Comparing a resolved file path against an unresolved root rejects every
      // config whenever the root is a link — macOS /var -> /private/var, a home
      // on a network mount, a ~/code symlink. No CI runner here has one, so this
      // is the only thing standing between that and a silent no-op for those
      // users.
      const real = workspace();
      const link = join(mkdtempSync(join(tmpdir(), "ix-linkroot-")), "root");
      workspaces.push(dirname(link));
      try {
        symlinkSync(real, link, "dir");
      } catch {
        return; // no permission to symlink (e.g. restricted CI) — nothing to assert
      }
      write(
        real,
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core": ["src/worker"] } } }),
      );
      write(real, "src/worker.ts");
      write(real, "src/consumer.ts");
      const resolve = createTypeScriptModuleResolver(link, [
        join(link, "tsconfig.json"),
        join(link, "src/worker.ts"),
        join(link, "src/consumer.ts"),
      ]);

      expect(resolve("src/consumer.ts", "@core")).toEqual(["src/worker.ts"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses an extends that reaches a device node through a symlink",
    () => {
      // Containment alone does not cover this: the link sits inside the
      // workspace and only the *target* is a character device, which reports
      // size 0 and would read forever.
      const root = workspace();
      const link = join(root, "linked.json");
      try {
        symlinkSync("/dev/zero", link);
      } catch {
        return; // no permission to symlink (e.g. restricted CI) — nothing to assert
      }
      const config = write(root, "tsconfig.json", JSON.stringify({ extends: "./linked.json" }));
      const consumer = write(root, "src/consumer.ts");
      const resolve = createTypeScriptModuleResolver(root, [config, consumer, link]);

      expect(resolve("src/consumer.ts", "@core")).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses an extends that reaches a FIFO without blocking on the open",
    () => {
      // The guard that rejects non-regular files runs *after* the open, and
      // opening a FIFO for reading blocks until a writer appears — so without
      // O_NONBLOCK the open never returns and no later check can save it. The
      // /dev/zero case does not cover this: a character device opens fine.
      const root = workspace();
      const fifo = join(root, "piped.json");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return; // no mkfifo available — nothing to assert
      }
      const config = write(root, "tsconfig.json", JSON.stringify({ extends: "./piped.json" }));
      const consumer = write(root, "src/consumer.ts");
      const resolve = createTypeScriptModuleResolver(root, [config, consumer, fifo]);

      expect(resolve("src/consumer.ts", "@core")).toBeUndefined();
    },
  );

  it("accepts a sibling directory whose name begins with dots", () => {
    // Containment must compare path segments: `..shared` is inside the
    // workspace, but a bare startsWith("..") reads it as an escape.
    const root = workspace();
    write(
      root,
      "..shared/tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@core": ["src/worker"] } } }),
    );
    const config = write(root, "tsconfig.json", JSON.stringify({ extends: "./..shared" }));
    const consumer = write(root, "src/consumer.ts");
    const worker = write(root, "..shared/src/worker.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, worker]);

    expect(resolve("src/consumer.ts", "@core")).toEqual(["..shared/src/worker.ts"]);
  });

  it("does not claim authority when an out-of-scope extends was dropped", () => {
    // A scoped ingest roots containment at the ingest path, so a shared base
    // config above it is dropped. Half-loading the remainder is worse than main:
    // the local `paths` rule matches, fails against the missing baseUrl, and
    // returns an authoritative [] that deletes an edge main resolves.
    const outer = workspace();
    writeFileSync(
      join(outer, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "." } }),
    );
    const scoped = join(outer, "packages", "web");
    mkdirSync(scoped, { recursive: true });
    const config = write(
      scoped,
      "tsconfig.json",
      JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { paths: { "@app/*": ["src/*"] } },
      }),
    );
    const consumer = write(scoped, "src/consumer.ts");
    const resolve = createTypeScriptModuleResolver(scoped, [config, consumer]);

    // undefined ("no opinion") lets the stem fallback run; [] would delete the edge.
    expect(resolve("src/consumer.ts", "@app/missing")).toBeUndefined();
  });

  it("follows a relative extends that names a directory", () => {
    // Previously an existsSync probe stopped at the directory itself and never
    // tried <dir>/tsconfig.json, so the parent's paths were silently dropped.
    const root = workspace();
    write(
      root,
      "cfg/tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@core": ["src/worker"] } } }),
    );
    const config = write(root, "tsconfig.json", JSON.stringify({ extends: "./cfg" }));
    const consumer = write(root, "src/consumer.ts");
    // `paths` in an extended config resolve against the config that declares them.
    const worker = write(root, "cfg/src/worker.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, worker]);

    expect(resolve("src/consumer.ts", "@core")).toEqual(["cfg/src/worker.ts"]);
  });

  it("prefers JavaScript for extensionless imports from JavaScript files", () => {
    const root = workspace();
    const config = write(
      root,
      "jsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: "src" },
      }),
    );
    const consumer = write(root, "src/consumer.js");
    const javascript = write(root, "src/services/worker.js");
    const typescript = write(root, "src/services/worker.ts");
    const resolve = createTypeScriptModuleResolver(root, [
      config,
      consumer,
      javascript,
      typescript,
    ]);

    expect(resolve("src/consumer.js", "services/worker")).toEqual(["src/services/worker.js"]);
  });

  it("does not serve one caller's language preference to another in the same directory", () => {
    // Guards the memo key: results are cached, and callers in the same folder
    // share a config but not a preference order. Keying on the directory alone
    // would hand the .js answer to the .ts caller, or whichever ran first.
    const root = workspace();
    const config = write(
      root,
      "jsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    );
    const jsConsumer = write(root, "src/consumer.js");
    const tsConsumer = write(root, "src/consumer.ts");
    const javascript = write(root, "src/services/worker.js");
    const typescript = write(root, "src/services/worker.ts");
    const resolve = createTypeScriptModuleResolver(root, [
      config,
      jsConsumer,
      tsConsumer,
      javascript,
      typescript,
    ]);

    // Order matters: whichever runs first would poison a directory-only key.
    expect(resolve("src/consumer.js", "services/worker")).toEqual(["src/services/worker.js"]);
    expect(resolve("src/consumer.ts", "services/worker")).toEqual(["src/services/worker.ts"]);
    // And repeated asks, which is what the cache exists for, stay stable.
    expect(resolve("src/consumer.js", "services/worker")).toEqual(["src/services/worker.js"]);
  });

  it("matches mapped paths case-insensitively on case-insensitive filesystems", () => {
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@utils": ["src/utils"] } } }),
    );
    const consumer = write(root, "src/consumer.ts");
    const actual = write(root, "src/Utils.ts");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, actual], {
      caseSensitive: false,
    });

    expect(resolve("src/consumer.ts", "@utils")).toEqual(["src/Utils.ts"]);
  });

  it("selects runtime and declaration targets for mapped JavaScript paths", () => {
    const root = workspace();
    const config = write(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@sample/tool": ["lib/index.js"] } },
      }),
    );
    const consumer = write(root, "apps/client.ts");
    const declarations = write(root, "lib/index.d.ts");
    const runtime = write(root, "lib/index.js");
    const resolve = createTypeScriptModuleResolver(root, [config, consumer, declarations, runtime]);

    expect(resolve("apps/client.ts", "@sample/tool", "runtime")).toEqual(["lib/index.js"]);
    expect(resolve("apps/client.ts", "@sample/tool", "types")).toEqual(["lib/index.d.ts"]);
  });
});
