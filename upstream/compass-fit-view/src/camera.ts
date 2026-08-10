/**
 * Camera fit logic for Ix System Compass — upstream port.
 *
 * Pure functions (no React): node bounding box, fit computation, and an
 * eased camera animation, mirroring the behavior of the shipped bundle's
 * `Zt` (fit computation) and `ee` (animated centering), but computed from
 * the *node* bounding box rather than the whole canvas.
 */

export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Camera {
  zoom: number;
  pan: { x: number; y: number };
}

export interface FitOptions {
  /** Inset from the viewport edges (px). */
  padding?: number;
  /** Absolute floor for the fit zoom (guards pathological layouts). */
  minZoom?: number;
  /** Ceiling for the fit zoom (same cap as the zoom-in button). */
  maxZoom?: number;
}

export type FitMode = 'fit' | 'readable';

const DEFAULT_FIT: Required<FitOptions> = {
  padding: 60,
  minZoom: 0.01,
  maxZoom: 2.5,
};

/** 'readable' keeps the view zoomed in far enough to read node labels. */
const READABLE_FLOOR = 0.05;
const READABLE_CEILING = 0.5;

export function nodeBounds(nodes: NodeRect[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
} | null {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Compute the camera that frames the given nodes in the viewport.
 * `mode: 'fit'` shows the whole graph; `mode: 'readable'` centers the same
 * bbox but never zooms below READABLE_FLOOR (labels stay legible).
 */
export function computeNodeFit(
  nodes: NodeRect[],
  viewport: Viewport,
  mode: FitMode = 'fit',
  opts: FitOptions = {},
): Camera | null {
  const bounds = nodeBounds(nodes);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

  const { padding, minZoom, maxZoom } = { ...DEFAULT_FIT, ...opts };
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);

  const fit = Math.min(availW / bounds.width, availH / bounds.height);
  const zoom =
    mode === 'readable'
      ? clamp(fit * 1.5, READABLE_FLOOR, READABLE_CEILING)
      : clamp(fit, minZoom, maxZoom);

  return {
    zoom,
    pan: {
      x: viewport.width / 2 - bounds.cx * zoom,
      y: viewport.height / 2 - bounds.cy * zoom,
    },
  };
}

/**
 * Animated camera transition (eased over `duration` ms), ported from the
 * bundle's `ee` helper: interpolate zoom and pan toward `target` with an
 * ease-out curve via requestAnimationFrame.
 */
export function animateCameraTo(
  target: Camera,
  from: Camera,
  duration = 240,
  onFrame: (camera: Camera) => void,
  onDone?: () => void,
): () => void {
  const start = performance.now();
  let raf = 0;

  const tick = (now: number) => {
    const p = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - p, 2.4); // easeOutExpo-ish
    onFrame({
      zoom: from.zoom + (target.zoom - from.zoom) * e,
      pan: {
        x: from.pan.x + (target.pan.x - from.pan.x) * e,
        y: from.pan.y + (target.pan.y - from.pan.y) * e,
      },
    });
    if (p < 1) {
      raf = requestAnimationFrame(tick);
    } else {
      onDone?.();
    }
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
