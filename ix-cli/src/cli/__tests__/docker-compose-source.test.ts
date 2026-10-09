// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

async function dockerStart(...flags: string[]): Promise<void> {
  const { registerDockerCommand } = await import("../commands/docker.js");
  const program = new Command().exitOverride();
  registerDockerCommand(program);
  await program.parseAsync(["docker", "start", ...flags], { from: "user" });
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
    expect(log()).toContain(`compose --env-file ${join(t, "ix-home", "backend", ".env")} -f ${local} up -d --pull always`);
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

describe("ix docker start --local-token", () => {
  const envFile = () => join(t, "ix-home", "backend", ".env");
  const config = () => readFileSync(join(t, "ix-home", "config.yaml"), "utf8");

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // The capabilities read after start: a backend that now enforces.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proFeaturesEnabled: false, local_auth: "bearer-v1", local_auth_enforcing: true })));
  });

  it.skipIf(process.platform === "win32")("is off by default: no token stored, an empty one passed to compose", async () => {
    process.env.IX_BUNDLED_COMPOSE = REPO_COMPOSE;
    await dockerStart();
    expect(readFileSync(envFile(), "utf8")).toBe("IX_LOCAL_TOKEN=\n");
    expect(existsSync(join(t, "ix-home", "config.yaml"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("stores a token, writes it to a 0600 .env and recreates the backend even when healthy", async () => {
    process.env.IX_BUNDLED_COMPOSE = REPO_COMPOSE;
    writeFileSync(join(t, "up"), ""); // already healthy
    await dockerStart("--local-token");

    const token = /local_token: (\w+)/.exec(config())?.[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(envFile(), "utf8")).toBe(`IX_LOCAL_TOKEN=${token}\n`);
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
    expect(log()).toMatch(/compose --env-file \S+ -f \S+ up -d --pull always/);

    // Running it again keeps the same token.
    await dockerStart("--local-token");
    expect(config()).toContain(`local_token: ${token}`);

    // --no-local-token forgets it and passes an empty one.
    await dockerStart("--no-local-token");
    expect(config()).not.toContain("local_token");
    expect(readFileSync(envFile(), "utf8")).toBe("IX_LOCAL_TOKEN=\n");
  });

  it.skipIf(process.platform === "win32")("refuses, running nothing, when the installed compose predates the token", async () => {
    mkdirSync(join(t, "ix-home", "backend"), { recursive: true });
    writeFileSync(join(t, "ix-home", "backend", "docker-compose.yml"), "services:\n  memory-layer:\n    image: x\n");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(dockerStart("--local-token")).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toMatch(/does not pass IX_LOCAL_TOKEN/);
    expect(log()).toBe("");
    expect(existsSync(join(t, "ix-home", "config.yaml"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("applies the user's override file", async () => {
    process.env.IX_BUNDLED_COMPOSE = REPO_COMPOSE;
    mkdirSync(join(t, "ix-home", "backend"), { recursive: true });
    const override = join(t, "ix-home", "backend", "docker-compose.override.yml");
    writeFileSync(override, "services:\n  arangodb:\n    ports: [\"127.0.0.1:8529:8529\"]\n");
    await dockerStart();
    expect(log()).toContain(`-f ${override} up -d`);
  });
});

async function docker(...args: string[]): Promise<void> {
  const { registerDockerCommand } = await import("../commands/docker.js");
  const program = new Command().exitOverride();
  registerDockerCommand(program);
  await program.parseAsync(["docker", ...args], { from: "user" });
}

describe("~/.ix/backend/.env: only start writes it, and it keeps what the user set", () => {
  const backend = () => join(t, "ix-home", "backend");
  const envFile = () => join(backend(), ".env");
  const HAND_SET = "# my notes\nCOMPOSE_PROJECT_NAME=backend\n\nIX_LOCAL_TOKEN=\"hand-set-token\"\nFOO=bar\n";

  beforeEach(() => {
    process.env.IX_BUNDLED_COMPOSE = REPO_COMPOSE;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proFeaturesEnabled: false, local_auth: "bearer-v1", local_auth_enforcing: true })));
    mkdirSync(backend(), { recursive: true });
    writeFileSync(envFile(), HAND_SET, { mode: 0o600 });
  });

  it.skipIf(process.platform === "win32")("status, stop and restart read it but never rewrite it", async () => {
    writeFileSync(join(t, "up"), ""); // healthy, so status also asks compose for arangodb
    await docker("status");
    await docker("stop");
    await docker("restart");
    expect(readFileSync(envFile(), "utf8")).toBe(HAND_SET);
    // compose is still pointed at it, so ${IX_LOCAL_TOKEN} resolves the same.
    expect(log()).toContain(`compose --env-file ${envFile()} -f ${join(backend(), "docker-compose.yml")} ps`);
    expect(log()).toMatch(/ down\n/);
    expect(log()).toMatch(/ restart\n/);
  });

  it.skipIf(process.platform === "win32")("logs never rewrites it", async () => {
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => { resolve(code); }) as never);
    });
    await docker("logs");
    expect(await exited).toBe(0);
    expect(readFileSync(envFile(), "utf8")).toBe(HAND_SET);
    expect(log()).toContain(`--env-file ${envFile()}`);
  });

  it.skipIf(process.platform === "win32")("read-only commands create none and pass none when it is missing", async () => {
    rmSync(envFile());
    writeFileSync(join(t, "up"), "");
    await docker("status");
    expect(existsSync(envFile())).toBe(false);
    expect(log()).not.toContain("--env-file");
  });

  it.skipIf(process.platform === "win32")("start keeps a hand-set token and the user's other lines when none is stored", async () => {
    await dockerStart();
    expect(readFileSync(envFile(), "utf8")).toBe(HAND_SET);
    expect(log()).toMatch(/up -d --pull always/);
    expect(existsSync(join(t, "ix-home", "config.yaml"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("start --local-token adopts the hand-set token instead of generating another", async () => {
    await dockerStart("--local-token");
    expect(readFileSync(join(t, "ix-home", "config.yaml"), "utf8")).toContain("local_token: hand-set-token");
    expect(readFileSync(envFile(), "utf8")).toBe(HAND_SET);
  });

  it.skipIf(process.platform === "win32")("a stored token wins over a different hand-set one, in place", async () => {
    writeFileSync(join(t, "ix-home", "config.yaml"), "auth:\n  local_token: stored-token\n");
    await dockerStart();
    expect(readFileSync(envFile(), "utf8"))
      .toBe("# my notes\nCOMPOSE_PROJECT_NAME=backend\n\nIX_LOCAL_TOKEN=stored-token\nFOO=bar\n");
  });

  it.skipIf(process.platform === "win32")("start --no-local-token clears the token but keeps the other lines", async () => {
    await dockerStart("--no-local-token");
    expect(readFileSync(envFile(), "utf8"))
      .toBe("# my notes\nCOMPOSE_PROJECT_NAME=backend\n\nIX_LOCAL_TOKEN=\nFOO=bar\n");
  });
});

describe("backend .env helpers", () => {
  it("reads the token Compose would: the last assignment, unquoted, empty as none", async () => {
    const { envFileLocalToken } = await import("../backend-compose.js");
    expect(envFileLocalToken("")).toBeUndefined();
    expect(envFileLocalToken("IX_LOCAL_TOKEN=\n")).toBeUndefined();
    expect(envFileLocalToken("IX_LOCAL_TOKEN=a\r\nexport IX_LOCAL_TOKEN='b'\n")).toBe("b");
    expect(envFileLocalToken("# IX_LOCAL_TOKEN=commented\nX_IX_LOCAL_TOKEN=other\n")).toBeUndefined();
  });

  it("chooses the stored token, else the hand-set one unless clearing", async () => {
    const { backendStartToken } = await import("../backend-compose.js");
    expect(backendStartToken("s", "IX_LOCAL_TOKEN=h\n")).toBe("s");
    expect(backendStartToken(undefined, "IX_LOCAL_TOKEN=h\n")).toBe("h");
    expect(backendStartToken(undefined, "IX_LOCAL_TOKEN=h\n", true)).toBeUndefined();
    expect(backendStartToken(undefined, "")).toBeUndefined();
  });

  it("does not rewrite a file that already says the same", async () => {
    const { writeBackendEnv } = await import("../backend-compose.js");
    const env = join(t, "same.env");
    writeFileSync(env, "IX_LOCAL_TOKEN=x\n", { mode: 0o644 });
    writeBackendEnv("x", env);
    if (process.platform !== "win32") expect(statSync(env).mode & 0o777).toBe(0o644);
    writeBackendEnv("y", env);
    expect(readFileSync(env, "utf8")).toBe("IX_LOCAL_TOKEN=y\n");
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
