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
import { findWorkspaceForCwd, getDefaultWorkspace, loadWorkspaces, getEndpoint } from "../config.js";
import { detectSystem } from "../system.js";
import { IxClient } from "../../client/api.js";

const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const PID_FILE = join(IX_HOME, "compass.pid");
// Records the workspace scope (id, or "*all*") of the running visualizer, so a second
// `ix view` launched from a different workspace can warn instead of silently showing the
// already-running (differently-scoped) instance.
const SCOPE_FILE = join(IX_HOME, "compass.scope");
const PORT_FILE = join(IX_HOME, "compass.port");
/**
 * `.cjs`, not `.js`.
 *
 * The script this writes is CommonJS — it `require`s http, fs and path. A `.js`
 * file's module system is decided by the nearest `package.json` *above it*, so
 * with `IX_HOME` anywhere under a directory declaring `"type": "module"`, node
 * refuses the script with `require is not defined in ES module scope` and
 * `ix view` reports only "started … but is not yet serving", which names
 * neither the cause nor the fix. `.cjs` is CommonJS whatever any ancestor
 * says. (`$HOME/package.json` is rare but real — this box has one.)
 */
const SERVER_SCRIPT_FILE = join(IX_HOME, "tmp", "compass-server.cjs");
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

function removeCompassState(): void {
  for (const path of [PID_FILE, SCOPE_FILE, PORT_FILE]) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

function parsePort(value: string): number | null {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Read a file, keeping "not there" and "there but unreadable" apart.
 *
 * Collapsing both to null is the tempting shape and the wrong one. An
 * unreadable compass.pid — a directory left by a botched extract, a root-owned
 * file after one `sudo ix` — would read as "no visualizer running", and the
 * callers act on that: one deletes a live server's state files, the other goes
 * on to spawn a second server it then cannot record or stop. Only ENOENT means
 * absent. Anything else is a real problem and belongs to the caller.
 *
 * Reading straight out instead of checking existsSync first is what closes
 * CodeQL js/file-system-race: the check could always go stale before the read,
 * and it never told us the read would succeed anyway.
 */
function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read the persisted port, falling back to the server script written by older releases.
 *
 * Unlike the PID and scope reads, this one does swallow an unreadable file: it
 * is a best-effort lookup for a URL to print, not a liveness check, so a corrupt
 * compass.port should degrade to the legacy script rather than fail the command.
 * That was already the behaviour; only the existsSync guards are gone.
 */
function readRunningPort(): number | null {
  try {
    const raw = readTextIfPresent(PORT_FILE);
    const port = raw === null ? null : parsePort(raw);
    if (port !== null) return port;
  } catch {
    // Fall through to the legacy server script.
  }

  try {
    const match = readTextIfPresent(SERVER_SCRIPT_FILE)?.match(/^const PORT = (\d+);$/m);
    const port = match?.[1] ? parsePort(match[1]) : null;
    if (port !== null) {
      // Best-effort migration for a visualizer started before compass.port existed.
      try { writeFileSync(PORT_FILE, String(port)); } catch { /* ignore */ }
    }
    return port;
  } catch {
    return null;
  }
}

/**
 * What to print under "already running", given where it is actually serving.
 *
 * #358 made this branch report the running port instead of echoing back the one
 * just requested, which fixed the unreachable URL. It stayed silent about the
 * request itself though, so `ix view -p 19124` against a server on 19123 prints
 * a correct URL for a port you did not ask for and never says the flag was
 * ignored — you find out by noticing the number changed.
 *
 * Pure, because the decision is all this is, and inline in a command action it
 * could only be exercised by launching a detached server.
 */
export function runningInstanceLines(
  runningPort: number | null,
  requestedPort: number,
  portWasRequested: boolean,
): string[] {
  if (runningPort === null) {
    return [
      "[!] The running visualizer's port is unknown.",
      "    Run 'ix view stop' then 'ix view' to restart it.",
    ];
  }

  const lines = [`  http://localhost:${runningPort}`];
  if (portWasRequested && runningPort !== requestedPort) {
    lines.push(`[!] You asked for port ${requestedPort}, but it is serving on ${runningPort}.`);
    lines.push(`    Run 'ix view stop' then 'ix view -p ${requestedPort}' to move it.`);
  }
  return lines;
}

/**
 * Read PID from file and check if the process is alive.
 *
 * An unreadable PID file throws rather than reporting "not running". Both
 * callers treat null as licence to act — `stop` wipes the state files, `start`
 * launches a detached server — so answering null for a file we simply could not
 * read would delete a live server's only record, or orphan a fresh one.
 */
function readAlivePid(): number | null {
  const raw = readTextIfPresent(PID_FILE);
  if (raw === null) {
    removeCompassState();
    return null;
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    removeCompassState();
    return null;
  }
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return pid;
  } catch {
    // Stale PID file
    removeCompassState();
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

/**
 * Wait for the detached server to accept connections.
 *
 * It is spawned with `stdio: "ignore"`, so anything it writes on the way down
 * goes nowhere — including the throw that now guards its argument contract.
 * Without this the CLI printed "[ok] Visualizer started", wrote a PID file for
 * a dead process and opened a browser on a closed port.
 *
 * Polls rather than watching for `exit`: the child is detached and unref'd, and
 * the question worth answering is whether the port is actually serving, not
 * whether the process happens to still be alive.
 */
async function waitForServer(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Path to the CLI entry point of the install generating this script.
 *
 * Taken from this module's own location rather than derived from the compass
 * dist directory, so it holds for a repo checkout as well as an install.
 */
function cliMainForScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "main.js");
}

/** Build the argv payload shared by the production launcher and server tests. */
export function serverRuntimeArgs(
  distDir: string,
  port: number,
  workspaceId: string | null,
  systemId: string | null,
  mapRoot: string | null,
  cliMainPath: string = cliMainForScript(),
): string[] {
  return [
    distDir,
    String(port),
    workspaceId ?? "",
    systemId ?? "",
    mapRoot ?? "",
    cliMainPath,
  ];
}

/**
 * Generate the invariant server script that serves static files + proxies /v1.
 *
 * Runtime values are supplied as argv when the script is spawned. In
 * particular, SYSTEM_ID may come from the backend, so embedding it here would
 * create a network-data-to-executable-file path even though JSON.stringify
 * made the generated JavaScript syntactically safe.
 */
export function serverScript(): string {
  return `
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { execFile } = require("child_process");

const DIST = process.argv[2];
const PORT = Number(process.argv[3]);
// How long to wait on the backend before answering 504. Generous, because it
// must not fire on a legitimately slow read: /v1/map rebuilds the whole map on
// every call and has been measured at 276s on a large graph. Overridable only
// under NODE_ENV=test, like the seams below, so a shipped install cannot be
// given a short timeout through the environment — and so the timeout itself
// can be tested without a ten-minute test.
const PROXY_TIMEOUT_MS = (process.env.NODE_ENV === "test" && process.env.IX_VIEW_PROXY_TIMEOUT_MS)
  ? Number(process.env.IX_VIEW_PROXY_TIMEOUT_MS)
  : 600000;

const BACKEND = (process.env.NODE_ENV === "test" && process.env.IX_VIEW_BACKEND_URL)
  ? process.env.IX_VIEW_BACKEND_URL
  : ${JSON.stringify(BACKEND_URL)};
const WORKSPACE_ID = process.argv[4] || null;
const SYSTEM_ID = process.argv[5] || null;

// The workspace root /__ix/remap maps, resolved by ix view start rather than
// re-derived here — empty/null when --all left the view unscoped.
const MAP_ROOT = process.argv[6] || null;

// The CLI that generated this script, resolved from its own location at
// launch time. Deriving it here from DIST only worked for the installed
// layout; findCompassDist's dev branch returns a repo path, from which the
// same arithmetic lands on a file that never exists.
//
// The env override is a test seam and is honoured only under NODE_ENV=test, so
// a shipped install cannot be pointed at an arbitrary script through the
// environment.
const MAP_MAIN = (process.env.NODE_ENV === "test" && process.env.IX_VIEW_MAP_MAIN)
  ? process.env.IX_VIEW_MAP_MAIN
  : process.argv[7];

if (!DIST || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !MAP_MAIN) {
  throw new Error("invalid ix view server arguments");
}

// One map at a time. execFile is asynchronous, so nothing else serialises them.
let mapInFlight = null;

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
    // A backend that accepts the socket and then never answers used to hang
    // here for ever: node puts no timeout on an outgoing request, so the
    // browser waited indefinitely, Compass recorded neither a result nor a
    // failure, and the region sat at "loading …" with nothing to distinguish a
    // slow map from a dead one. Answering 504 turns that into a state the
    // client can render and a user can act on.
    //
    // Generous, because it must not fire on a legitimately slow read: /v1/map
    // rebuilds the whole map on every call and has been measured at 276s on a
    // large graph. This is the point past which silence is a fault rather than
    // patience.
    proxyReq.setTimeout(PROXY_TIMEOUT_MS, () => {
      proxyReq.destroy(new Error("backend timed out"));
    });
    proxyReq.on("error", (err) => {
      // Whatever went wrong, the client is still waiting; say something.
      if (res.headersSent) { res.destroy(); return; }
      const timedOut = err && err.message === "backend timed out";
      res.writeHead(timedOut ? 504 : 502, { "Content-Type": "text/plain" });
      res.end(timedOut ? "Backend timed out" : "Backend unavailable");
    });
    req.pipe(proxyReq);
    return;
  }

  // Real /__ix/remap - rebuild the code map for the workspace this visualizer
  // was launched from (its cwd), by running the CLI's map command against it. The
  // stock endpoint was a stub that returned the SPA HTML.
  //
  // Loopback-only: this endpoint shells out with the user's privileges, so
  // reject cross-site requests (CSRF / DNS-rebinding). Browsers send Origin on
  // cross-site POSTs; curl and same-origin fetches either omit it or send a
  // loopback origin. The Origin is parsed with the URL API rather than a regex
  // because this snippet lives inside a template literal and regex backslashes
  // would be consumed every time the server is regenerated by ix view start.
  if (pathname === "/__ix/remap" && req.method === "POST") {
    const origin = req.headers.origin || "";
    // Strip the port, keeping a bracketed IPv6 literal intact ([::1]:8080 -> [::1]).
    let host = (req.headers.host || "").toLowerCase();
    host = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    const loopbackHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    let loopbackOrigin = !origin;
    if (origin) {
      try {
        const u = new URL(origin);
        loopbackOrigin =
          (u.protocol === "http:" || u.protocol === "https:") &&
          (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") &&
          // Our own port, not merely some loopback one. Any page served on any
          // other localhost port — a dev server, a local docs site — can send a
          // simple POST with no preflight, and accepting the whole loopback
          // interface as one origin let it trigger a remap.
          u.port === String(PORT);
      } catch {
        loopbackOrigin = false;
      }
    }
    if (!loopbackHost || !loopbackOrigin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "forbidden: loopback only" }));
      return;
    }
    // Nothing reads the request body, but leaving it unconsumed holds the
    // stream open for the whole map.
    req.resume();
    // MAP_ROOT is the workspace this visualizer is showing, resolved once by
    // ix view start and supplied at launch. Mapping process.cwd() instead would
    // follow
    // whatever directory the detached server was launched from: --all does not
    // require that to be a workspace at all, so "ix view start --all" run from
    // a home directory turned one click into an ingest of the whole of it.
    if (!MAP_ROOT) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "remap needs a single workspace; this view was started with --all" }));
      return;
    }
    if (mapInFlight) {
      // execFile is async, so without this every POST starts another full
      // ingest and Louvain pass over the same workspace.
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "a remap is already running" }));
      return;
    }
    if (!fs.existsSync(MAP_MAIN)) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "ix CLI not found at " + MAP_MAIN }));
      return;
    }
    // --silent because nothing here reads stdout, and the default text render
    // is work done only to be thrown away. maxBuffer is raised anyway: the
    // default 1 MiB makes Node SIGTERM the child mid-map, which surfaces as a
    // 500 rather than as the truncation it is.
    const child = execFile(process.execPath, [MAP_MAIN, "map", MAP_ROOT, "--silent"], { cwd: MAP_ROOT, timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      mapInFlight = null;
      if (res.destroyed) return; // client disconnected while mapping
      res.writeHead(err ? 500 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !err, error: err ? String(stderr || err.message).slice(0, 400) : undefined }));
    });
    mapInFlight = child;
    // Stop the map if the client goes away before we respond. res "close" fires
    // on abnormal teardown too; writableEnded tells normal completion apart
    // from a disconnect (IncomingMessage "close" can fire on request completion
    // in some Node versions, which would kill the map mid-flight).
    //
    // Killing mid-map is safe: the ingest baseline is only persisted after a
    // clean run, so an interrupted map re-ingests next time rather than
    // recording files as done that never landed.
    res.on("close", () => { if (!res.writableEnded) { try { child.kill(); } catch {} } });
    return;
  }

  // Serve static files
  //
  // Sending no cache headers is not the same as sending "do not cache": with no
  // Cache-Control, no ETag and no Last-Modified, a browser picks its own
  // freshness heuristic and may reuse a response without ever asking. This
  // server always serves 127.0.0.1 on a port it reuses, so that cache outlives
  // an upgrade -- the old index.html comes back, names the old content-hashed
  // bundles, and the entire previous Compass runs while /.version, fetched
  // separately, reports the new build. The result is a status bar that says the
  // fix shipped while the screen shows the build before it.
  //
  // Everything under assets/ is fingerprinted by content, so its name changes
  // whenever it does and it can be kept forever. The entry points carry no
  // fingerprint and must never be served stale.
  //
  // Keyed on the file that is about to be sent, not on the URL that asked for
  // it. Those are not the same path: the SPA fallback below rewrites filePath
  // to index.html for any extensionless miss, so GET /assets/anything answers
  // with index.html -- and deciding from the URL would then stamp the entry
  // point "immutable" for a year under an /assets/ key. That is the permanent
  // form of the very bug this block exists to prevent.
  //
  // path.sep rather than a literal separator, and startsWith rather than a
  // regex: the whole script is emitted from a template literal, so a backslash
  // escape is eaten before it reaches the generated file and a backtick ends
  // the literal outright. Both were tried here; the second took the server
  // down. The trailing separator is what keeps a sibling directory named
  // assets-old from matching.
  const ASSET_PREFIX = path.join(DIST, "assets") + path.sep;
  const cacheControl = (f) =>
    f.startsWith(ASSET_PREFIX) ? "public, max-age=31536000, immutable" : "no-store";

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
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
        });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": cacheControl(filePath),
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  // Server ready — parent already detached
});
`;
}

/**
 * The URL to hand the browser: the server's URL, keyed by the build stamp.
 *
 * `Cache-Control: no-store` only reaches a response the browser actually asks
 * for. A client that cached `/` before the upgrade never asks — its entry is
 * still fresh, so it keeps serving the old index.html, which names the old
 * hashed bundles, and never learns the policy changed. `ix view` reuses
 * 127.0.0.1 on the same port across upgrades, so that entry outlives the
 * install meant to replace it. Without this, the header is prospective only:
 * it protects the next upgrade, not the one the user just ran, which is the
 * one they are looking at.
 *
 * A different query string is a different cache key, so the tab we open is a
 * real fetch whatever the browser is holding. The stamp comes from the dist,
 * so the key changes exactly when the bundle does and a start that changed
 * nothing still hits cache. The *printed* URL stays clean: this is a bust for
 * the tab we open, not a URL anyone should have to type.
 */
export function browserUrl(serverUrl: string, distDir: string): string {
  let stamp: string;
  try {
    stamp = readFileSync(join(distDir, ".version"), "utf8");
  } catch {
    // Absent and unreadable are the same answer here — there is no stamp to
    // key on — and the fallback is the plain URL either way, so nothing is
    // hidden by merging them. A dev build and a bundle from before the stamp
    // existed both land here.
    return serverUrl;
  }
  // Restrict to the characters a release stamp is actually made of
  // (`0.10.0-rc.10+release.6bce261`). Everything below runs the URL through a
  // shell, where `&` starts a second command; a stamp is a file on disk, so it
  // is not the CLI's own string to trust. Dropping the rest costs nothing —
  // any surviving difference is still a different cache key.
  const key = stamp.trim().replace(/[^A-Za-z0-9._+-]/g, "");
  return key ? `${serverUrl}/?v=${key}` : serverUrl;
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
      // Whether -p was typed, not whether it differs from 8080. Comparing against
      // the default instead would stay silent for someone who explicitly passed
      // `-p 8080` to a server running elsewhere — the exact case they typed the
      // flag to find out about — and would nag anyone who typed nothing.
      const portWasRequested = view.getOptionValueSource("port") === "cli";

      // Resolve the workspace this visualizer is scoped to. The proxy stamps it as
      // X-Ix-Workspace on every /v1 call so Compass isolates by workspace without any
      // workspace awareness of its own. --all opts out (show the whole backend).
      const workspaceId = opts.all ? null : (resolveWorkspaceId() ?? null);
      // Resolved the same way workspaceId is, so /__ix/remap re-maps exactly
      // what the visualizer is showing. Null under --all, which deliberately
      // scopes to nothing — there is no single workspace to rebuild.
      const mapRoot = opts.all
        ? null
        : ((findWorkspaceForCwd(process.cwd()) ?? getDefaultWorkspace())?.root_path ?? null);

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
        // The system id (from a local marker or the backend) becomes a proxy
        // header and persisted scope label, so constrain it to the known id
        // charset before either use.
        if (systemId !== null && !/^[A-Za-z0-9_.:-]+$/.test(systemId)) {
          systemId = null;
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
        for (const line of runningInstanceLines(readRunningPort(), port, portWasRequested)) {
          console.log(line);
        }
        // The running instance has a fixed scope (baked at launch). If this directory
        // maps to a different workspace, say so rather than silently showing the old one.
        // Unreadable must not read as "no scope": that would skip the check
        // below and quietly hand back another workspace's graph, which is the
        // exact confusion the scope file exists to prevent. Empty counts as
        // unknown too, not as a scope literally named "".
        const runningKey = readTextIfPresent(SCOPE_FILE)?.trim() || null;
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
        // Releases v0.7.0-v0.8.1 shipped an empty compass/ directory, so for
        // most users the bundle is genuinely absent rather than misplaced.
        // `ix upgrade` fetches it from ix-compass-dist and repairs the install.
        console.error("  Fetch it with:  ix upgrade");
        console.error("");
        console.error("  The visualizer normally ships inside the Ix release tarball.");
        console.error("  If 'ix upgrade' does not resolve it, please report the issue at");
        console.error("  https://github.com/ix-infrastructure/Ix/issues");
        process.exit(1);
      }

      // Write server script to temp location
      const scriptDir = dirname(SERVER_SCRIPT_FILE);
      mkdirSync(scriptDir, { recursive: true });
      // The file is deliberately invariant: systemId can be returned by the
      // backend and must never flow into JavaScript that is written and then
      // executed. Runtime values travel as argv instead.
      writeFileSync(SERVER_SCRIPT_FILE, serverScript());

      // Spawn detached process
      const child = spawn(process.execPath, [
        SERVER_SCRIPT_FILE,
        ...serverRuntimeArgs(distDir, port, workspaceId, systemId, mapRoot),
      ], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      if (!child.pid) {
        console.error("[error] Failed to start visualizer server.");
        process.exit(1);
      }

      // A pid only means the spawn succeeded — see waitForServer.
      const ready = await waitForServer(port);

      // Save PID, scope, and port for subsequent start/status/stop commands.
      mkdirSync(dirname(PID_FILE), { recursive: true });
      writeFileSync(PID_FILE, String(child.pid));
      writeFileSync(SCOPE_FILE, scopeKey);
      writeFileSync(PORT_FILE, String(port));

      const url = `http://localhost:${port}`;

      // Reported rather than fatal: the wait is a heuristic, and a machine slow
      // enough to exceed it would otherwise have a working visualizer killed off
      // or the command fail. The PID/scope/port files are written either way, so
      // `ix view status` and `ix view stop` still work on whatever did start.
      if (!ready) {
        console.error(`[!] Visualizer started (PID ${child.pid}) but is not yet serving ${url}.`);
        console.error("    If it does not come up shortly, run 'ix view stop', then");
        console.error("    'ix upgrade' if the Compass bundle is missing or incomplete.");
        return;
      }

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
        openBrowser(browserUrl(url, distDir));
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

      removeCompassState();
      console.log(`[ok] Visualizer stopped (PID ${pid})`);
    });

  view
    .command("status")
    .description("Show visualizer status")
    .action(() => {
      const pid = readAlivePid();
      if (pid) {
        console.log(`[ok] Visualizer is running (PID ${pid})`);
        // Now that the port is recorded, status can answer the question people
        // actually run it to answer. Shares runningInstanceLines with the
        // already-running branch above so the two cannot drift: an instance
        // started before the port file existed still has no port to report, and
        // saying so beats printing nothing to someone who ran status *for* the
        // URL. Never guessed either way — a confidently wrong URL is #358.
        // `status` takes no -p, so the mismatch branch cannot fire here.
        for (const line of runningInstanceLines(readRunningPort(), 0, false)) {
          console.log(line);
        }
      } else {
        console.log("[--] Visualizer is not running.");
        console.log("  Run 'ix view' to start it.");
      }
    });
}
