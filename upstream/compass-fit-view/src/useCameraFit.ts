/**
 * React wiring for the Compass fit-view — upstream port.
 *
 * Assumes a camera store (context or zustand-style) exposing:
 *   { zoom, pan, setZoom(zoom), setPan(pan), nodes: NodeRect[] }
 * The bundle drives this through `setZoom`/`setPan`; adapt the accessor names
 * to the real store when integrating.
 *
 * Behavior:
 *  - F / f  → fit the whole node graph (animated)
 *  - On mount, once nodes are non-empty → auto-frame at a readable zoom
 *    (fixes the empty-canvas first paint)
 *  - When the node *set* changes (drill in/out, late loads) → re-frame
 *  - Never re-frames on user panning (only node-set changes trigger it)
 *  - Exposes `hasAutoFramed`, so a first-run hint chip (see FitViewHint) can
 *    appear at exactly the moment the graph frames — never over an empty
 *    canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  animateCameraTo,
  computeNodeFit,
  type Camera,
  type FitMode,
  type NodeRect,
  type Viewport,
} from './camera';

export interface CameraStore {
  zoom: number;
  pan: { x: number; y: number };
  nodes: NodeRect[];
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
}

export interface UseCameraFitOptions {
  store: CameraStore;
  viewport: Viewport;
  /** Disable auto-frame on mount / node-set change. */
  disableAutoFrame?: boolean;
}

export function useCameraFit({ store, viewport, disableAutoFrame }: UseCameraFitOptions) {
  const { nodes, zoom, pan } = store;
  const raf = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const [hasAutoFramed, setHasAutoFramed] = useState(false);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const frameTo = useCallback(
    (mode: FitMode, animate: boolean) => {
      const target = computeNodeFit(store.nodes, viewportRef.current, mode);
      if (!target) return;
      raf.current?.();
      if (!animate) {
        store.setZoom(target.zoom);
        store.setPan(target.pan);
        return;
      }
      raf.current = animateCameraTo(
        target,
        { zoom: store.zoom, pan: store.pan },
        240,
        (c: Camera) => {
          store.setZoom(c.zoom);
          store.setPan(c.pan);
        },
      );
    },
    [store],
  );

  const fitView = useCallback(() => frameTo('fit', true), [frameTo]);

  // F / f — fit the whole graph. Mirrors the bundle's keydown hook (`Ie`):
  // add `case 'f': case 'F': onFitView()` alongside the existing cases.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'f' && ev.key !== 'F') return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      ev.preventDefault();
      fitView();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fitView]);

  // Auto-frame once on first paint, then only when the node *set* changes
  // (identity of the node array, not pan/zoom — so user panning is safe).
  const nodeKey = useMemo(() => nodes.map((n) => `${n.x},${n.y},${n.width},${n.height}`).join('|'), [nodes]);
  const prevKey = useRef<string | null>(null);

  useEffect(() => {
    if (disableAutoFrame) return;
    if (!nodes.length) return;
    if (!mounted.current) {
      mounted.current = true;
      frameTo('readable', false);
      setHasAutoFramed(true);
      return;
    }
    if (prevKey.current !== null && prevKey.current !== nodeKey) {
      frameTo('readable', false);
    }
    prevKey.current = nodeKey;
  }, [nodeKey, nodes.length, frameTo, disableAutoFrame]);

  // Keep the previous key in sync across renders even when nodes is empty.
  useEffect(() => {
    prevKey.current = nodeKey;
  }, [nodeKey]);

  useEffect(() => () => raf.current?.(), []);

  return { fitView, zoom, pan, hasAutoFramed };
}
