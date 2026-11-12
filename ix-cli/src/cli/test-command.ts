// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import type { TestReach } from "./tests-for.js";

const quote = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;

/** Read only known runner configs, inside the workspace, with a size bound. */
function config(root: string, dir: string, name: string): string | undefined {
  try {
    const file = realpathSync(path.join(dir, name));
    const rel = path.relative(realpathSync(root), file);
    if (rel.startsWith("..") || path.isAbsolute(rel) || statSync(file).size > 256 * 1024) return;
    return readFileSync(file, "utf8");
  } catch {
    return;
  }
}

/** Suggestions only: never execute repo scripts or guess a runner for an unknown config. */
export function inferTestCommand(root: string, test: TestReach): string | undefined {
  root = path.resolve(root);
  if (!test.path) return;
  const absolute = path.resolve(root, test.path);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  let dir = path.dirname(absolute);
  while (true) {
    const localFile = path.relative(dir, absolute).split(path.sep).join("/");
    let command: string | undefined;
    if (/\.[cm]?[jt]sx?$/.test(test.path)) {
      const text = config(root, dir, "package.json");
      if (text) {
        try {
          const scripts = JSON.parse(text).scripts ?? {};
          const runner = Object.entries(scripts)
            .filter(
              ([key, value]) =>
                /^test(?::[\w-]+)?$/.test(key) &&
                typeof value === "string" &&
                /\b(?:vitest|jest|mocha|playwright)\b|\bnode\s+--test\b/.test(value) &&
                !/[;&|\n]|\b(?:watch|coverage)\b/.test(value),
            )
            .sort(([a], [b]) => (a === "test" ? -1 : b === "test" ? 1 : a.localeCompare(b)))[0];
          if (runner) command = `npm run ${runner[0]} -- ${quote(localFile)}`;
        } catch {
          /* Malformed config: no suggestion. */
        }
        // A nested package is the runner boundary, even without a known test script.
        if (!command) return;
      }
    } else if (test.path.endsWith(".py")) {
      const pytest =
        config(root, dir, "pytest.ini") !== undefined ||
        /\[tool\.pytest(?:\.ini_options)?\]/.test(config(root, dir, "pyproject.toml") ?? "") ||
        /\[(?:tool:)?pytest\]/.test(
          (config(root, dir, "setup.cfg") ?? "") + (config(root, dir, "tox.ini") ?? ""),
        );
      if (pytest)
        command = `python -m pytest ${quote(localFile + (test.kind !== "file" ? `::${(test.selector ?? test.name).replace(/\./g, "::")}` : ""))}`;
    } else if (test.path.endsWith(".go") && config(root, dir, "go.mod") !== undefined) {
      const pkg = path.posix.dirname(localFile);
      command = `go test ${quote(pkg === "." ? "./" : `./${pkg}`)}`;
      if (test.kind !== "file" && /^Test\w+$/.test(test.name))
        command += ` -run ${quote(`^${test.name}$`)}`;
    } else if (
      /\.(?:java|scala)$/.test(test.path) &&
      config(root, dir, "build.sbt") !== undefined
    ) {
      // sbt needs the fully qualified suite; recover its package from the source.
      let source = "";
      try {
        const file = realpathSync(absolute);
        const rel = path.relative(realpathSync(root), file);
        if (!rel.startsWith("..") && !path.isAbsolute(rel) && statSync(file).size <= 256 * 1024)
          source = readFileSync(file, "utf8");
      } catch {
        return;
      }
      const pkg = source.match(/^\s*package\s+([\w.]+)/m)?.[1];
      const selector = test.selector ?? test.name;
      const suite = selector.includes(".")
        ? selector.split(".")[0]
        : path.basename(test.path).replace(/\.[^.]+$/, "");
      if (/^\w+$/.test(suite)) command = `sbt ${quote(`testOnly ${pkg ? `${pkg}.` : ""}${suite}`)}`;
    }
    if (command) {
      const cwd = path.relative(root, dir).split(path.sep).join("/");
      return cwd ? `cd ${quote(cwd)} && ${command}` : command;
    }
    if (dir === path.resolve(root)) return;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
