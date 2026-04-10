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

const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const STATE_FILE = join(IX_HOME, "compass.json");
const BACKEND_URL = "http://localhost:8090";

interface CompassState {
  pid: number;
  port: number;
}

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

/** Read state from file and check if the process is alive. */
function readAliveState(): CompassState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const state: CompassState = JSON.parse(
      readFileSync(STATE_FILE, "utf-8").trim(),
    );
    if (!state.pid || !state.port) return null;
    process.kill(state.pid, 0); // signal 0 = existence check
    return state;
  } catch {
    // Stale or corrupt state file
    try {
      unlinkSync(STATE_FILE);
    } catch {
      /* ignore */
    }
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
    conn.on("error", () => {
      resolve(false);
    });
  });
}

/** Generate the inline server script that serves static files + proxies /v1. */
function serverScript(distDir: string, port: number): string {
  return `
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const DIST = ${JSON.stringify(distDir)};
const PORT = ${port};
const BACKEND = ${JSON.stringify(BACKEND_URL)};

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
    const proxyReq = http.request(backendUrl, {
      method: req.method,
      headers: { ...req.headers, host: "localhost:8090" },
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

server.on("error", (err) => {
  process.exit(1);
});

server.listen(PORT, () => {
  // Signal readiness to parent via stdout
  process.stdout.write("READY");
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
    .description("Open the Ix System Compass visualizer");

  view
    .command("start", { isDefault: true })
    .description("Start the visualizer (default)")
    .option("-p, --port <port>", "Port to serve on", "8080")
    .option("--no-open", "Don't auto-open browser")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error("[error] Invalid port number.");
        process.exit(1);
      }

      const existing = readAliveState();
      if (existing) {
        console.log(
          `[ok] Visualizer is already running (PID ${existing.pid})`,
        );
        console.log(`  http://localhost:${existing.port}`);
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
      writeFileSync(scriptPath, serverScript(distDir, port));

      // Spawn detached process — capture stdout for readiness signal
      const child = spawn("node", [scriptPath], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (!child.pid) {
        console.error("[error] Failed to start visualizer server.");
        process.exit(1);
      }

      // Wait for the server to signal readiness or fail
      const ready = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(false);
        }, 5000);

        child.stdout!.on("data", (data: Buffer) => {
          if (data.toString().includes("READY")) {
            clearTimeout(timeout);
            resolve(true);
          }
        });

        child.stderr!.on("data", () => {
          // Server wrote to stderr — likely an error
        });

        child.on("exit", () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });

      if (!ready) {
        console.error(`[error] Visualizer failed to start on port ${port}.`);
        console.error(`  The port may be in use. Use -p <port> to specify a different port.`);
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        process.exit(1);
      }

      // Detach stdio so the parent can exit
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.unref();

      // Save state (PID + port)
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(
        STATE_FILE,
        JSON.stringify({ pid: child.pid, port } as CompassState),
      );

      const url = `http://localhost:${port}`;
      console.log(`[ok] Visualizer started (PID ${child.pid})`);
      console.log(`  ${url}`);

      if (opts.open !== false) {
        openBrowser(url);
      }
    });

  view
    .command("stop")
    .description("Stop the visualizer")
    .action(() => {
      const state = readAliveState();
      if (!state) {
        console.log("[ok] Visualizer is not running.");
        return;
      }

      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Already dead
      }

      try {
        unlinkSync(STATE_FILE);
      } catch {
        /* ignore */
      }
      console.log(`[ok] Visualizer stopped (PID ${state.pid})`);
    });

  view
    .command("status")
    .description("Show visualizer status")
    .action(() => {
      const state = readAliveState();
      if (state) {
        console.log(`[ok] Visualizer is running (PID ${state.pid})`);
        console.log(`  http://localhost:${state.port}`);
      } else {
        console.log("[--] Visualizer is not running.");
        console.log("  Run 'ix view' to start it.");
      }
    });
}
