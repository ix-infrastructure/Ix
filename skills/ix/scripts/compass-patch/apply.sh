#!/usr/bin/env bash
#
# Apply the Ix Compass "fit view" patch to the installed Compass UI.
#
# - Copies fit-view.js into the Compass dir (served at /fit-view.js).
# - Adds the <script> tag to index.html (idempotent).
# - Adds the F-key entry to the built-in keyboard-help pane (idempotent).
#
# Idempotent — safe to re-run. Re-apply after every `ix upgrade`, because the
# installer wipes the Compass dir. The skill's bootstrap does this
# automatically; run manually with:
#   bash skills/ix/scripts/compass-patch/apply.sh
#
# Env: IX_HOME (default ~/.ix), IX_SKIP_COMPASS_PATCH=1 to skip.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IX_HOME="${IX_HOME:-$HOME/.ix}"
export IX_HOME
COMPASS="$IX_HOME/cli/compass"

[ -f "$COMPASS/index.html" ] || {
  echo "error: Compass UI not found at $COMPASS (run 'ix upgrade' first)" >&2
  exit 1
}

# 1. The patch script itself.
cp "$HERE/fit-view.js" "$COMPASS/fit-view.js"

# 2. index.html script tag (idempotent via marker).
if ! grep -q "fit-view.js" "$COMPASS/index.html"; then
  sed -i 's#</body>#<script src="/fit-view.js" defer></script></body>#' "$COMPASS/index.html"
  echo "index.html: added fit-view.js script tag"
else
  echo "index.html: already patched"
fi

# 3. Keyboard-help entry (idempotent; non-fatal if python is unavailable).
python - <<'PY' || { echo "keyboard help: skipped (python unavailable)"; }
import glob, os
matches = glob.glob(os.path.join(os.environ["IX_HOME"], "cli", "compass", "assets", "KeyboardHelp-*.js"))
if not matches:
    print("keyboard help: chunk not found (skip)")
    raise SystemExit(0)
for p in matches:
    with open(p, encoding="utf-8") as f:
        s = f.read()
    if "{keys:[`F`]" in s:
        print("keyboard help: already patched (%s)" % os.path.basename(p))
        continue
    marker = "{keys:[`0`],label:`Reset zoom & center`}"
    add = marker + ",{keys:[`F`],label:`Fit view (fit whole graph)`}"
    if marker in s:
        s = s.replace(marker, add, 1)
        with open(p, "w", encoding="utf-8") as f:
            f.write(s)
        print("keyboard help: added F key (%s)" % os.path.basename(p))
    else:
        print("keyboard help: marker not found (%s) - patch may be stale, check Compass version" % os.path.basename(p))
PY

# 4. Real /__ix/remap endpoint in the visualizer server (idempotent).
#    The generated compass-server.js is rebuilt from the serverScript()
#    template in the CLI's view.js on every `ix view start`, so patch the
#    template: the stock /__ix/remap was a stub that returned the SPA HTML.
#    Non-fatal if the CLI layout changed (older/newer version).
python - <<'PY' || { echo "view.js server: skipped (python unavailable)"; }
import os
p = os.path.join(os.environ["IX_HOME"], "cli", "cli", "dist", "cli", "commands", "view.js")
if not os.path.exists(p):
    print("view.js server: not found (skip)")
    raise SystemExit(0)
with open(p, encoding="utf-8") as f:
    s = f.read()
if "IX_SKILL_REMAP" in s:
    print("view.js server: remap endpoint already patched")
    raise SystemExit(0)
anchor = "  // Serve static files"
handler = """  // IX_SKILL_REMAP: real /__ix/remap - rebuild the code map for the
  // workspace this visualizer was launched from (its cwd), via the CLI's
  // main.js. The stock endpoint was a stub (SPA fallback).
  if (pathname === "/__ix/remap" && req.method === "POST") {
    const { execFile } = require("child_process");
    const IX_HOME = path.resolve(DIST, "..", "..");
    const CLI_MAIN = path.join(IX_HOME, "cli", "cli", "dist", "cli", "main.js");
    const child = execFile(process.execPath, [CLI_MAIN, "map", "."], { cwd: process.cwd(), timeout: 1800000 }, (err, stdout, stderr) => {
      res.writeHead(err ? 500 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !err, error: err ? String(stderr || err.message).slice(0, 400) : undefined }));
    });
    req.on("close", () => { try { child.kill(); } catch {} });
    return;
  }

"""
if anchor not in s:
    print("view.js server: anchor not found - patch may be stale, check CLI version")
    raise SystemExit(0)
s = s.replace(anchor, handler + anchor, 1)
with open(p, "w", encoding="utf-8") as f:
    f.write(s)
print("view.js server: added real /__ix/remap endpoint")
PY

echo "Compass fit-view patch applied. Restart the visualizer (ix view stop && ix view) so the regenerated server picks up the real /__ix/remap endpoint; reload the tab to activate (F = fit view; auto-frames on load; no-map chip offers run ix map)."
