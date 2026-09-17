import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";

const roots: string[] = [];
const loader = ts.transpileModule(readFileSync(new URL("../register/pro-loader.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
afterEach(() => { for (const root of roots.splice(0)) {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
} });
function run(code?: string, exports: unknown = { "./register": "./register.js" }) {
  const root = mkdtempSync(join(tmpdir(), "ix-pro-loader-")); roots.push(root);
  writeFileSync(join(root, "loader.mjs"), loader);
  writeFileSync(join(root, "run.mjs"), `
    import {tryLoadProCommands} from './loader.mjs';
    const p={commands:[]};
    try {const loaded=await tryLoadProCommands(p); console.log(JSON.stringify({loaded,commands:p.commands}));}
    catch(e){console.error(e.message);process.exitCode=1;}
  `);
  if (code !== undefined) {
    const pro = join(root, "node_modules", "@ix", "pro"); mkdirSync(pro, { recursive: true });
    writeFileSync(join(pro, "package.json"), JSON.stringify({ name: "@ix/pro", type: "module", exports }));
    writeFileSync(join(pro, "register.js"), code);
  }
  const result=spawnSync(process.execPath,[join(root,"run.mjs")],{cwd:root,encoding:"utf8",timeout:15000});
  expect(result.error).toBeUndefined(); return result;
}
it("keeps a real OSS installation without Pro usable", () => {
  const r=run(); expect(r.status).toBe(0); expect(JSON.parse(r.stdout)).toEqual({loaded:false,commands:[]});
});
it("awaits real asynchronous Pro registration", () => {
  const r=run('export async function registerProCommands(p){await Promise.resolve();p.commands.push("synthetic");}');
  expect(r.status).toBe(0); expect(JSON.parse(r.stdout)).toEqual({loaded:true,commands:["synthetic"]});
});
it.each([
  ['missing nested peer', 'import "missing-synthetic-cli-peer"; export function registerProCommands(){}'],
  ['missing registration export', 'export const unrelated=true;'],
  ['failed credential guard', 'export async function registerProCommands(){throw new Error("synthetic-auth-guard-failed");}'],
])("fails closed for an installed plugin with %s", (_label, code) => {
  const r=run(code); expect(r.status).toBe(1); expect(r.stderr).toContain("Installed Ix Pro could not initialize");
  expect(r.stdout).toBe("");
});
it("does not treat an installed plugin with a missing export path as absent", () => {
  const r=run('export const unrelated=true;', {".":"./register.js"});
  expect(r.status).toBe(1); expect(r.stderr).toContain("Installed Ix Pro could not be resolved");
});
// Copyright 2026 Ix Infrastructure Inc.
