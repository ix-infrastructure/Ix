// Copyright 2026 Ix Infrastructure Inc.

import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("typechecks the CLI without core-ingestion build artifacts or dependencies", () => {
  const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const hidden = ["dist", "node_modules"].map((dir) => resolve(packageRoot, "../core-ingestion", dir));
  const isHidden = (path: string) => hidden.some((dir) => resolve(path) === dir || resolve(path).startsWith(dir + sep));
  // Hide artifacts through the compiler host rather than moving shared build
  // output while other tests may be using it.
  const configFile = ts.readConfigFile(resolve(packageRoot, "tsconfig.json"), ts.sys.readFile);
  expect(configFile.error).toBeUndefined();
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot, { noEmit: true });
  expect(config.errors).toEqual([]);
  const host = ts.createCompilerHost(config.options);
  const { fileExists, directoryExists, readFile } = host;
  host.fileExists = (path) => !isHidden(path) && fileExists(path);
  host.directoryExists = (path) => !isHidden(path) && directoryExists!(path);
  host.readFile = (path) => isHidden(path) ? undefined : readFile(path);
  const program = ts.createProgram(config.fileNames, config.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => "\n",
  })).toBe("");
}, 60_000);
