import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { buildPackageRegistry, detectSystem, readPackageNames, readPackageDeps } from "../system.js";

// Real on-disk fixtures: buildPackageRegistry reads each member's build manifest.
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-sysreg-"));
  const write = (rel: string, content: string) => {
    const p = nodePath.join(root, rel);
    fs.mkdirSync(nodePath.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  // Rust crate: Cargo name has a hyphen; code imports the underscore form.
  write("grep-matcher/Cargo.toml", '[package]\nname = "grep-matcher"\nversion = "0.1.0"\n');
  write("grep-matcher/src/lib.rs", "pub fn m() {}\n");
  // JS package: scoped, hyphenated; imports keep the hyphen.
  write("app/package.json", '{ "name": "@scope/helper-foo", "version": "1.0.0" }');
  write("app/index.js", "export const x = 1;\n");
  // Maven modules: a library and a dependent module. The dependent's pom has a
  // <parent> ref (must NOT be read as its name) and a <dependency> on the library.
  write("lib/pom.xml",
    '<project><parent><artifactId>acme-parent</artifactId></parent>' +
    '<artifactId>acme-lib</artifactId></project>');
  write("lib/src/main/java/A.java", "package com.acme.lib;\npublic class A {}\n");
  write("consumer/pom.xml",
    '<project><parent><artifactId>acme-parent</artifactId></parent>' +
    '<artifactId>acme-consumer</artifactId>' +
    '<dependencies><dependency><groupId>com.acme</groupId>' +
    '<artifactId>acme-lib</artifactId></dependency></dependencies></project>');
  write("consumer/src/main/java/B.java", "package com.acme.consumer;\nimport com.acme.lib.A;\npublic class B { A a; }\n");
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("buildPackageRegistry", () => {
  it("indexes the Cargo name, its stem, AND the underscore alias (Rust crate id)", () => {
    const reg = buildPackageRegistry(root, ["grep-matcher", "app"]);
    // Cargo hyphen name + its underscore alias both resolve to the rust member.
    expect(reg["grep-matcher"]).toBe("grep-matcher");
    expect(reg["grep_matcher"]).toBe("grep-matcher"); // the fix: `use grep_matcher::...`
    // JS scoped name + stem still resolve; hyphen preserved (no false underscore-only entry needed).
    expect(reg["@scope/helper-foo"]).toBe("app");
    expect(reg["helper-foo"]).toBe("app");
    expect(reg["helper_foo"]).toBe("app"); // alias also present, harmless for JS
  });

  it("detectSystem recognizes all members", () => {
    const d = detectSystem(root);
    expect(d).toBeTruthy();
    expect(d!.members.sort()).toEqual(["app", "consumer", "grep-matcher", "lib"]);
  });
});

describe("Maven name + declared-dependency graph", () => {
  it("reads the module's OWN artifactId, not the <parent> ref", () => {
    expect(readPackageNames(nodePath.join(root, "lib"))).toContain("acme-lib");
    expect(readPackageNames(nodePath.join(root, "consumer"))).toContain("acme-consumer");
    expect(readPackageNames(nodePath.join(root, "consumer"))).not.toContain("acme-parent");
  });

  it("readPackageDeps extracts declared <dependency> artifactIds", () => {
    expect(readPackageDeps(nodePath.join(root, "consumer"))).toContain("acme-lib");
  });

  it("detectSystem builds the ground-truth repoDeps graph (consumer -> lib)", () => {
    const d = detectSystem(root)!;
    expect(d.repoDeps["consumer"]).toContain("lib");
    // lib declares no intra-system deps.
    expect(d.repoDeps["lib"]).toBeUndefined();
  });
});
