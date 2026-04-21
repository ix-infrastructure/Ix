import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

// Redirect ~/.ix to a temp dir per-test so we don't trample the developer's
// real config.yaml. node:os.homedir() is vi.mocked at module scope.
const tmpHome = mkdtempSync(join(tmpdir(), "ix-cli-config-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tmpHome };
});

import {
  saveConfig,
  loadConfig,
  storeAuth,
  clearAuth,
  getAuthToken,
  getActiveInstance,
  refreshAuthIfNeeded,
  type IxConfig,
  type InstanceAuth,
} from "../config.js";

const configPath = () => join(tmpHome, ".ix", "config.yaml");

function seedConfig(overrides: Partial<IxConfig> = {}): void {
  const base: IxConfig = {
    endpoint: "http://localhost:8090",
    format: "text",
    instances: { myteam: { endpoint: "https://cloud.ix-infra.com" } },
    active: "myteam",
    ...overrides,
  };
  saveConfig(base);
}

const sampleAuth: InstanceAuth = {
  api_key: "sk-test-key-1234",
  token: "jwt-token-abc",
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  org_id: "org-test",
  plan: "pro",
};

beforeEach(() => {
  rmSync(join(tmpHome, ".ix"), { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveConfig file permissions", () => {
  it("writes config.yaml with 0600 permissions on first write", () => {
    seedConfig();
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates ~/.ix directory with 0700 permissions when missing", () => {
    seedConfig();
    const dirMode = statSync(join(tmpHome, ".ix")).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("tightens perms on a pre-existing 0644 file (older clients)", () => {
    mkdirSync(join(tmpHome, ".ix"), { mode: 0o755, recursive: true });
    writeFileSync(configPath(), "endpoint: http://localhost:8090\nformat: text\n", { mode: 0o644 });
    expect(statSync(configPath()).mode & 0o777).toBe(0o644);

    saveConfig({ endpoint: "http://localhost:8090", format: "text" });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

describe("storeAuth / clearAuth", () => {
  it("stores auth on a registered instance", () => {
    seedConfig();
    storeAuth("myteam", sampleAuth);
    const cfg = loadConfig() as IxConfig;
    expect(cfg.instances?.myteam.auth).toEqual(sampleAuth);
  });

  it("is a no-op for an unregistered instance (does not invent the instance)", () => {
    seedConfig();
    storeAuth("ghost", sampleAuth);
    const cfg = loadConfig() as IxConfig;
    expect(cfg.instances?.ghost).toBeUndefined();
  });

  it("clearAuth removes only the auth field, keeps the instance entry", () => {
    seedConfig();
    storeAuth("myteam", sampleAuth);
    clearAuth("myteam");
    const cfg = loadConfig() as IxConfig;
    expect(cfg.instances?.myteam).toBeDefined();
    expect(cfg.instances?.myteam.auth).toBeUndefined();
  });

  it("written config carries no looser perms even after auth round-trip", () => {
    seedConfig();
    storeAuth("myteam", sampleAuth);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    clearAuth("myteam");
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

describe("getAuthToken expiry", () => {
  it("returns the token when not expired", () => {
    seedConfig();
    storeAuth("myteam", sampleAuth);
    expect(getAuthToken()).toBe(sampleAuth.token);
  });

  it("returns undefined when the token has expired", () => {
    seedConfig();
    storeAuth("myteam", {
      ...sampleAuth,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(getAuthToken()).toBeUndefined();
  });

  it("returns undefined when there is no active instance", () => {
    seedConfig({ active: undefined });
    expect(getAuthToken()).toBeUndefined();
  });
});

describe("getActiveInstance", () => {
  it("resolves the active instance entry", () => {
    seedConfig();
    expect(getActiveInstance()?.endpoint).toBe("https://cloud.ix-infra.com");
  });

  it("returns undefined when active points at a missing instance", () => {
    seedConfig({ instances: {}, active: "ghost" });
    expect(getActiveInstance()).toBeUndefined();
  });
});

describe("refreshAuthIfNeeded — 429 contract", () => {
  it("returns the existing token unchanged when /auth/token returns 429", async () => {
    seedConfig();
    // Force expiry inside the 2-min refresh buffer so refresh attempts.
    storeAuth("myteam", {
      ...sampleAuth,
      expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tok = await refreshAuthIfNeeded();
    expect(tok).toBe(sampleAuth.token);
    expect(fetchMock).toHaveBeenCalledOnce();
    // Stored auth must NOT have been overwritten with empty fields.
    const stored = (loadConfig() as IxConfig).instances?.myteam.auth;
    expect(stored?.token).toBe(sampleAuth.token);
  });

  it("sends Authorization: Bearer header (forward-compat with header-only contract)", async () => {
    seedConfig();
    storeAuth("myteam", {
      ...sampleAuth,
      expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        token: "new-jwt", expires_at: new Date(Date.now() + 3600_000).toISOString(),
        org_id: "org-test", plan: "pro",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshAuthIfNeeded();
    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${sampleAuth.api_key}`);
  });

  it("returns the cached token without fetching when far from expiry", async () => {
    seedConfig();
    storeAuth("myteam", sampleAuth); // expires in ~1h, well outside 2-min buffer
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tok = await refreshAuthIfNeeded();
    expect(tok).toBe(sampleAuth.token);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
