// Copyright 2026 Ix Infrastructure Inc.

// Starts or stops the harness stack: `node test/e2e/stack.mjs up|down|logs`.
//
// compose.e2e.yml pins the backend image as a literal line so Dependabot can
// propose bumps. To test another image, set IX_E2E_BACKEND_IMAGE: this script
// then adds compose.image-override.yml, which swaps it in.

/* global process */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = ["-f", join(here, "compose.e2e.yml")];
if (process.env.IX_E2E_BACKEND_IMAGE) files.push("-f", join(here, "compose.image-override.yml"));

const actions = {
  up: ["up", "-d", "--wait", "--wait-timeout", "240"],
  down: ["down", "-v"],
  logs: ["logs", "--tail", "200"],
};
const action = actions[process.argv[2]];
if (!action) {
  process.stderr.write("usage: node test/e2e/stack.mjs up|down|logs\n");
  process.exit(2);
}
const res = spawnSync("docker", ["compose", ...files, ...action], { stdio: "inherit" });
process.exit(res.status ?? 1);
