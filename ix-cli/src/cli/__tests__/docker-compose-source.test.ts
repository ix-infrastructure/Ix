// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

/**
 * `ix docker start` used to fall back to ./docker-compose.yml when
 * ~/.ix/backend had none, so running it inside an untrusted repository ran
 * whatever services that repository declared. The backend compose file now
 * comes only from the copy the CLI ships.
 */

const REPO_COMPOSE = resolve(fileURLToPath(new URL("../../../../docker-compose.standalone.yml", import.meta.url)));

let t: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.resetModules();
  t = mkdtempSync(join(tmpdir(), "ix-docker-src-"));
  saved = {
    PATH: process.env.PATH,
    IX_HOME: process.env.IX_HOME,
    IX_BUNDLED_COMPOSE: process.env.IX_BUNDLED_COMPOSE,
    CWD: process.cwd(),
  };
  // docker records every call; `compose ... up` marks the backend as started.
  // curl answers the health probes: unhealthy until `up` ran.
  mkdirSync(join(t, "bin"));
  writeFileSync(join(t, "bin", "docker"), `#!/bin/sh\necho "$*" >> "${t}/docker.log"\ncase "$*" in *" up "*) touch "${t}/up" ;; esac\nexit 0\n`);
  writeFileSync(join(t, "bin", "curl"), `#!/bin/sh\n[ -f "${t}/up" ]\n`);
  chmodSync(join(t, "bin", "docker"), 0o755);
  chmodSync(join(t, "bin", "curl"), 0o755);
  process.env.PATH = `${join(t, "bin")}:${process.env.PATH}`;
  process.env.IX_HOME = join(t, "ix-home");
  // A repository carrying its own compose file, as an attacker's would.
  mkdirSync(join(t, "repo"));
  writeFileSync(join(t, "repo", "docker-compose.yml"), "services:\n  evil:\n    image: evil\n");
  process.chdir(join(t, "repo"));
});

afterEach(() => {
  process.chdir(saved.CWD!);
  for (const k of ["PATH", "IX_HOME", "IX_BUNDLED_COMPOSE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  rmSync(t, { recursive: true, force: true });
});

async function dockerStart(): Promise<void> {
  const { registerDockerCommand } = await import("../commands/docker.js");
  const program = new Command().exitOverride();
  registerDockerCommand(program);
  await program.parseAsync(["docker", "start"], { from: "user" });
}

const log = () => (existsSync(join(t, "docker.log")) ? readFileSync(join(t, "docker.log"), "utf8") : "");

describe("ix docker start: where the compose file comes from", () => {
  it.skipIf(process.platform === "win32")("writes the shipped compose file and never runs the repository's", async () => {
    process.env.IX_BUNDLED_COMPOSE = REPO_COMPOSE;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await dockerStart();

    const local = join(t, "ix-home", "backend", "docker-compose.yml");
    expect(readFileSync(local, "utf8")).toBe(readFileSync(REPO_COMPOSE, "utf8"));
    expect(log()).toContain(`compose -f ${local} up -d --pull always`);
    expect(log()).not.toContain(join(t, "repo"));
  });

  it.skipIf(process.platform === "win32")("fails with a message and runs nothing when no compose file ships", async () => {
    process.env.IX_BUNDLED_COMPOSE = "";
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(dockerStart()).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toMatch(/No backend compose file/);
    expect(log()).not.toMatch(/compose/);
  });
});

describe("isIxArangoVolume", () => {
  const labels = (project: string, volume: string) =>
    new Map([["com.docker.compose.project", project], ["com.docker.compose.volume", volume]]);

  it("matches only the Ix backends' own ArangoDB volume", async () => {
    const { isIxArangoVolume } = await import("../commands/docker.js");
    expect(isIxArangoVolume(labels("backend", "arangodb-data"))).toBe(true);
    expect(isIxArangoVolume(labels("ix", "arangodb-data"))).toBe(true);
    // Other stacks on the same machine, which --remove-all-data used to delete.
    expect(isIxArangoVolume(labels("ix-bench", "arangodb-data"))).toBe(false);
    expect(isIxArangoVolume(labels("ix-personal", "arangodb-data"))).toBe(false);
    expect(isIxArangoVolume(labels("ix-e2e", "arangodb-data"))).toBe(false);
    expect(isIxArangoVolume(labels("backend", "arango-backup"))).toBe(false);
  });
});
