import { Command } from "commander";
import { execSync, spawn } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { createConnection } from "net";
import { resolveWorkspaceId } from "../bootstrap.js";
import { findWorkspaceForCwd, loadWorkspaces, getEndpoint } from "../config.js";
import { detectSystem } from "../system.js";
import { IxClient } from "../../client/api.js";

const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const PID_FILE = join(IX_HOME, "compass.pid");
// Records the workspace scope (id, or "*all*") of the running visualizer, so a second
// `ix view` launched from a different workspace can warn instead of silently showing the
// already-running (differently-scoped) instance.
const SCOPE_FILE = join(IX_HOME, "compass.scope");
const BACKEND_URL = "http://localhost:8090";

/** Resolve the compass dist directory — installed path first, then dev fallback. */
function findCompassDist(): string | null {
  // Installed: $IX_HOME/cli/compass/
  const installed = join(IX_HOME, "cli", "compass");
  if (existsSync(join(installed, "index.html"))) return installed;

  // Dev / repo: relative to this file → ../../compass/dist/
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const repoDist = join(thisDir, "..", "..", "..", "compass", "dist");
  if (existsSync(join(repoDist, "index.html"))) return repoDist;

  return null;
}

/** Read PID from file and check if the process is alive. */
function readAlivePid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return pid;
  } catch {
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    try { unlinkSync(SCOPE_FILE); } catch { /* ignore */ }
    return null;
  }
}

/** Check whether a port is already in use. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: "127.0.0.1" });
    conn.on("connect", () => {
      conn.end();
      resolve(true);
    });
    conn.on("error", () => resolve(false));
  });
}

/** Generate the inline server script that serves static files + proxies /v1. */
function serverScript(distDir: string, port: number, workspaceId: string | null, systemId: string | null): string {
  return `
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const DIST = ${JSON.stringify(distDir)};
const PORT = ${port};
const BACKEND = ${JSON.stringify(BACKEND_URL)};
const WORKSPACE_ID = ${JSON.stringify(workspaceId)};
const SYSTEM_ID = ${JSON.stringify(systemId)};

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json",
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || "/";

  // Proxy /v1 requests to backend
  if (pathname.startsWith("/v1")) {
    const backendUrl = BACKEND + pathname + (parsed.search || "");
    const proxyHeaders = { ...req.headers, host: "localhost:8090" };
    // Scope every proxied read to the workspace ix view was launched in, so the
    // System Compass visualiser isolates by workspace without the browser app
    // knowing anything about workspaces. The backend reads X-Ix-Workspace as a
    // fallback when no explicit workspace_id is on the request.
    if (WORKSPACE_ID) proxyHeaders["x-ix-workspace"] = WORKSPACE_ID;
    // When the launch directory is a multi-repo system, scope by system instead.
    // Co-ingest stores each member repo under its own workspace_id plus a shared
    // system_id, so a workspace-only scope (the parent dir's path-id) matches no
    // member nodes and Compass renders empty. X-Ix-System unions every member's
    // nodes plus the cross-repo edges; the backend (SystemScope) gives it
    // precedence over the workspace scope, so sending both is safe.
    if (SYSTEM_ID) proxyHeaders["x-ix-system"] = SYSTEM_ID;
    const proxyReq = http.request(backendUrl, {
      method: req.method,
      headers: proxyHeaders,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Backend unavailable");
    });
    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let filePath = path.join(DIST, pathname === "/" ? "index.html" : pathname);

  // SPA fallback: if file doesn't exist and no extension, serve index.html
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    filePath = path.join(DIST, "index.html");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback for all 404s
      fs.readFile(path.join(DIST, "index.html"), (err2, fallback) => {
        if (err2) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  // Server ready — parent already detached
});
`;
}

function openBrowser(url: string): void {
  try {
    const plat = platform();
    if (plat === "darwin") {
      execSync(`open ${url}`, { stdio: "ignore" });
    } else if (plat === "win32") {
      execSync(`start ${url}`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open ${url}`, { stdio: "ignore" });
    }
  } catch {
    // Non-critical
  }
}

export function registerViewCommand(program: Command): void {
  const view = program
    .command("view")
    .description("Open the Ix System Compass visualizer")
    .option("-p, --port <port>", "Port to serve on", "8080");

  view
    .command("start", { isDefault: true })
    .description("Start the visualizer (default)")
    .option("--no-open", "Don't auto-open browser")
    .option("--all", "Show every ingested workspace together (no workspace scoping)")
    .action(async (opts) => {
      const port = parseInt(view.opts().port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error("[error] Invalid port number.");
        process.exit(1);
      }

      // Resolve the workspace this visualizer is scoped to. The proxy stamps it as
      // X-Ix-Workspace on every /v1 call so Compass isolates by workspace without any
      // workspace awareness of its own. --all opts out (show the whole backend).
      const workspaceId = opts.all ? null : (resolveWorkspaceId() ?? null);

      // If the launch directory is a multi-repo system, scope by system_id instead of
      // workspace_id: co-ingested member repos live under their own workspace_ids, so a
      // workspace-only scope finds nothing (this is the "Compass not connected" bug).
      // Mirror `ix map`: detectSystem finds a locally co-ingested system; a repo the
      // stitcher joined into a system has no local marker, so fall back to the backend
      // lookup. --all opts out of all scoping.
      let systemId: string | null = null;
      if (!opts.all) {
        systemId = detectSystem(process.cwd())?.systemId ?? null;
        if (!systemId && workspaceId) {
          try {
            const looked = await new IxClient(getEndpoint()).workspaceSystem(workspaceId);
            systemId = looked.systemId ?? null;
          } catch {
            // Older backend without the stitch endpoint, or backend down — fall back to
            // workspace scoping (single-repo behavior is unaffected).
          }
        }
      }
      const workspaceName = workspaceId
        ? (findWorkspaceForCwd(process.cwd())?.workspace_name ?? workspaceId)
        : null;
      // A system scope takes precedence (it's what the proxy sends), so it also keys the
      // running-instance scope so launching from a member repo rescopes correctly.
      const scopeKey = systemId ? `system:${systemId}` : (workspaceId ?? "*all*");
      const scopeLabel = systemId
        ? `system "${systemId}"`
        : (workspaceName ? `workspace "${workspaceName}"` : "all workspaces");

      const existing = readAlivePid();
      if (existing) {
        console.log(`[ok] Visualizer is already running (PID ${existing})`);
        console.log(`  http://localhost:${port}`);
        // The running instance has a fixed scope (baked at launch). If this directory
        // maps to a different workspace, say so rather than silently showing the old one.
        const runningKey = existsSync(SCOPE_FILE) ? readFileSync(SCOPE_FILE, "utf-8").trim() : null;
        if (runningKey !== null && runningKey !== scopeKey) {
          const runningLabel = runningKey === "*all*"
            ? "all workspaces"
            : `workspace "${loadWorkspaces().find(w => w.workspace_id === runningKey)?.workspace_name ?? runningKey}"`;
          console.log(`[!] It is scoped to ${runningLabel}, but this directory maps to ${scopeLabel}.`);
          console.log(`    Run 'ix view stop' then 'ix view' here to rescope.`);
        }
        return;
      }

      // Check if the port is already in use before attempting to start
      if (await isPortInUse(port)) {
        console.error(`[error] Port ${port} is already in use.`);
        console.error(`  Use -p <port> to specify a different port.`);
        process.exit(1);
      }

      const distDir = findCompassDist();
      if (!distDir) {
        console.error("[error] Compass UI not found.");
        console.error("  Expected at: $IX_HOME/cli/compass/ (installed)");
        console.error("  or: <repo>/compass/dist/ (development)");
        console.error("");
        console.error("  The visualizer ships with the Ix release tarball.");
        console.error("  Reinstall Ix or build system-compass locally.");
        process.exit(1);
      }

      // Write server script to temp location
      const scriptDir = join(IX_HOME, "tmp");
      mkdirSync(scriptDir, { recursive: true });
      const scriptPath = join(scriptDir, "compass-server.js");
      writeFileSync(scriptPath, serverScript(distDir, port, workspaceId, systemId));

      // Spawn detached process
      const child = spawn("node", [scriptPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      if (!child.pid) {
        console.error("[error] Failed to start visualizer server.");
        process.exit(1);
      }

      // Save PID + the scope it was launched with (for the mismatch warning above).
      mkdirSync(dirname(PID_FILE), { recursive: true });
      writeFileSync(PID_FILE, String(child.pid));
      writeFileSync(SCOPE_FILE, scopeKey);

      const url = `http://localhost:${port}`;
      console.log(`[ok] Visualizer started (PID ${child.pid})`);
      console.log(`  ${url}`);
      console.log(
        systemId
          ? `  scope: ${scopeLabel}`
          : workspaceName
            ? `  scope: workspace "${workspaceName}"`
            : `  scope: all workspaces${opts.all ? " (--all)" : ""}`
      );

      if (opts.open !== false) {
        openBrowser(url);
      }
    });

  view
    .command("stop")
    .description("Stop the visualizer")
    .action(() => {
      const pid = readAlivePid();
      if (!pid) {
        console.log("[ok] Visualizer is not running.");
        return;
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead
      }

      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      try { unlinkSync(SCOPE_FILE); } catch { /* ignore */ }
      console.log(`[ok] Visualizer stopped (PID ${pid})`);
    });

  view
    .command("status")
    .description("Show visualizer status")
    .action(() => {
      const pid = readAlivePid();
      if (pid) {
        console.log(`[ok] Visualizer is running (PID ${pid})`);
      } else {
        console.log("[--] Visualizer is not running.");
        console.log("  Run 'ix view' to start it.");
      }
    });
}
