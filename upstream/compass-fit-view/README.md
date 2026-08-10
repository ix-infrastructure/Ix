# Compass — "Fit view" upstream port

A ready-to-submit implementation of the fit-view behavior, written against the
Ix System Compass source architecture. This is the **proper** version of the
runtime patch in `skills/ix/scripts/compass-patch/` — it works on the real
React state (nodes, camera store) instead of poking the DOM.

## Status: source not yet accessible

As of this writing the Compass **source repo is private / not reachable**:

- `ix-infrastructure` public repos contain only `ix-compass-dist` (a bare
  release channel — just a README, no code) and plugin repos.
- No compass branch exists in `ix-infrastructure/Ix` (checked `git ls-remote`,
  including `old-dev`).
- GitHub code search for the bundle's own markers (`ix-crisp-canvas`) finds
  nothing public.
- The shipped bundle has no sourcemaps.

Once the source is reachable (grant the account access, or point this repo at
the real location), apply these files, wire them per the map below, and open
the PR.

## What it does

1. **`F` / `f`** — fit the whole node graph into the viewport (animated).
2. **Auto-frame on mount** — after the graph loads, center on the nodes bbox at
   a readable zoom, so the canvas never opens on an empty corner (the shipped
   default pan lands on empty space for sparse/spread layouts).
3. Re-frame when the visible node set changes (drill in/out).
4. **First-run hint chip** — a small "`F` fit view" chip appears once, right
   when the graph finishes auto-framing, then fades out on its own (~7s),
   is click-to-dismiss, and is remembered per origin (`localStorage`) so it
   never nags again. Theme-aware via design tokens; `role="status"` for
   screen readers.
5. **No-map chip** — when the scoped workspace has no graph, an actionable
   "No map yet — run ix map" chip replaces the F hint. Clicking it POSTs
   `/__ix/remap`, shows a Mapping state, and reloads when the rebuild
   completes. Session-dismissible (it must keep offering the action until a
   map exists). Requires the visualizer server to implement a real
   `/__ix/remap` — the stock endpoint is a stub that returns the SPA HTML;
   the skill's `apply.sh` patches the server template to run `ix map .`
   (see `skills/ix/scripts/compass-patch/apply.sh`).
6. **Keyboard + tooltips** — both chips are **Escape-dismissible** (guarded
   against typing in inputs), and each carries a `title` tooltip summarizing
   the shortcut set (`F` fit view, `?` shortcuts, `Esc` dismiss / hide) so
   the affordance stays discoverable for keyboard users.
7. **Live theme re-sampling** — the chips' colors come from CSS variables
   (`--color-card` / `--color-border` / `--color-foreground`, with dark
   fallbacks). Because the app flips a `dark` class on `<html>` that redefines
   those variables, an open chip re-themes **instantly when the app theme
   changes live** — no reload needed. This mirrors the runtime patch, which
   listens to `prefers-color-scheme` AND a MutationObserver on the `dark`
   class and re-applies the sampled tokens (the port's CSS-var approach is
   the race-free version of that).

## How it maps to the shipped bundle (v0.2.0)

The bundle is minified, but the pieces are identifiable. Match these to the
source names when integrating:

| Minified symbol | What it is | Port maps to |
|---|---|---|
| `Zt(e,t,n)` | computes `{fitZoom, fitPan}` from container + content size | `computeNodeFit` (but fed the **nodes bbox**, not the canvas) |
| `P` (`onZoomReset`) | `setZoom(k.fitZoom), setPan(k.fitPan)` — fits the whole *canvas* | `fitToNodes('fit')` |
| `ee(t)` | rAF animation: centers on selected node or all-nodes bbox at zoom `t` | `animateCameraTo` (reused as-is) |
| `k.fitZoom` / `k.fitPan` | config fit values | replaced by per-call computed fit |
| `Ie({...})` keydown hook | `case '+'/'-'/'0'/'l'/'i'` etc. | add `case 'f'` / `case 'F'` → `onFitView` |
| `KeyboardHelp` component | `o` array of `{keys, label}` | add `{ keys: ['F'], label: 'Fit view' }` |
| `.ix-crisp-canvas` render | `style={{ zoom, width, height }}`, wrapper `translate(pan)` | unchanged (this is what `setZoom`/`setPan` drive) |

## Files

- `src/camera.ts` — pure logic: node bbox, `computeNodeFit`, `animateCameraTo`.
  No React imports; unit-testable.
- `src/useCameraFit.ts` — React hook: `F`-key wiring, mount auto-frame, node-set
  change reframe, and a `hasAutoFramed` flag for the hint chip. Assumes a
  camera store exposing `{ zoom, pan, setZoom, setPan, nodes }` (adapt the
  accessor names to the real store).
- `src/KeyboardHelp.tsx` — the patched shortcuts list (drop-in for the real
  component).
- `src/FitViewHint.tsx` — both chips. `FitViewHint` (F hint) plus
  `RunIxMapHint` (no-map action) and the `remapProject` / `hasSeenHint` /
  `markHintSeen` pure helpers (injectable storage) for unit tests. Each
  accepts a `show` prop so it renders only in its matching state.

## Integration checklist (once the source is available)

1. Copy `src/camera.ts` into the camera/geometry module; replace the canvas-fit
   computation with `computeNodeFit(nodes, viewport)` where the old `fitZoom`
   was derived.
2. Add `fitToNodes(mode)` to the camera store: `animateCameraTo(computeNodeFit(...))`.
3. In the keyboard hook, add `case 'f': case 'F': e.onFitView()` (mirror the
   existing `onZoomReset` wiring) and pass `onFitView` through.
4. Add the `{ keys: ['F'], label: 'Fit view' }` entry to `KeyboardHelp`.
5. In the graph view component, run `fitToNodes('readable')` once when nodes
   first become non-empty (guard so it doesn't fight user panning — the runtime
   patch re-frames only when the node *set* changes, never on pan).
6. Render `<FitViewHint show={hasAutoFramed} />` (graph present) and
   `<RunIxMapHint show={nodes.length === 0} />` (no graph) in the graph view.
   Swap the inline `var(--color-*)` tokens for the design system's theme
   hooks.
7. Implement a real `/__ix/remap` endpoint on the visualizer server: run
   `ix map .` in the workspace, respond with JSON `{ ok: true }` when done.
   (The stock endpoint is a stub; `apply.sh` shows the reference handler.)
7. Optionally expose it in the command bar / toolbar alongside Zoom in/out.
8. Run the app's lint/tests, then open the PR against the Compass repo.
