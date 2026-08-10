/**
 * FitViewHint — first-run affordances for the fit-view feature (upstream port).
 *
 * Two chips, mirroring the runtime patch in
 * `skills/ix/scripts/compass-patch/fit-view.js`:
 *
 * - `FitViewHint` — "F = fit view" shown once on first load, right when the
 *   graph finishes auto-framing. Auto-fades after a few seconds, is
 *   click-to-dismiss, and is remembered per origin (localStorage) so it never
 *   nags again.
 * - `RunIxMapHint` — "No map yet — run ix map" shown when the scoped
 *   workspace has no graph. Clicking POSTs the (real) /__ix/remap endpoint,
 *   shows a Mapping state, and reloads when the rebuild completes. Session-
 *   dismissible; reappears on next load until a map exists.
 *
 * This is the proper React version of the runtime patch's hint logic — it
 * renders through the component tree instead of appending DOM nodes, and pulls
 * colors from theme tokens instead of sampling computed styles.
 *
 * Usage (see useCameraFit): render each only in its matching state, so they
 * never float over the wrong canvas:
 *
 *   const { fitView, hasAutoFramed } = useCameraFit({ store, viewport });
 *   const noNodes = store.nodes.length === 0;
 *   ...
 *   {noNodes
 *     ? <RunIxMapHint show />
 *     : <FitViewHint show={hasAutoFramed} />}
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Per-origin remember key; override in tests or for per-user buckets. */
export const HINT_STORAGE_KEY = 'ix-fit-view-hint-seen-v1';

/** Auto-fade delay (ms) before the chip dissolves on its own. */
export const HINT_DISMISS_MS = 7000;
/** Fade-out transition length (ms) — mirrors the CSS transition. */
export const HINT_FADE_MS = 650;

export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage: HintStorage | undefined =
  typeof localStorage === 'undefined' ? undefined : localStorage;

/** True when the user has already seen (or dismissed) the hint. */
export function hasSeenHint(storage?: HintStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(HINT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the dismissal so the hint never returns for this origin. */
export function markHintSeen(storage?: HintStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(HINT_STORAGE_KEY, '1');
  } catch {
    // Storage can be unavailable (private mode, quota); the chip still works
    // for this session, it just may reappear next load.
  }
}

export interface FitViewHintProps {
  /** Render only when the graph has finished auto-framing. */
  show: boolean;
  /** Injectable storage for tests; defaults to window.localStorage. */
  storage?: HintStorage | null;
}

export function FitViewHint({ show, storage = defaultStorage }: FitViewHintProps) {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(() => hasSeenHint(storage));
  const fadeTimer = useRef<number | undefined>(undefined);
  const removeTimer = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    markHintSeen(storage);
    setVisible(false);
    // Remove from the DOM after the fade completes so it can't trap focus.
    window.setTimeout(() => setDismissed(true), HINT_FADE_MS);
  }, [storage]);

  useEffect(() => {
    if (!show || dismissed) return;
    // Delay appearance slightly so the chip lands after the frame animation
    // has visibly started, never before the canvas has content.
    const appear = window.setTimeout(() => setVisible(true), 350);
    return () => window.clearTimeout(appear);
  }, [show, dismissed]);

  useEffect(() => {
    if (!visible) return;
    fadeTimer.current = window.setTimeout(dismiss, HINT_DISMISS_MS);
    return () => {
      if (fadeTimer.current !== undefined) window.clearTimeout(fadeTimer.current);
      if (removeTimer.current !== undefined) window.clearTimeout(removeTimer.current);
    };
  }, [visible, dismiss]);

  // Keyboard-dismissible: Escape fades the chip out (same as clicking it).
  // Listen while the chip is in the DOM; the auto-fade keeps working.
  useEffect(() => {
    if (dismissed) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissed, dismiss]);

  if (dismissed) return null;

  return (
    <button
      type="button"
      role="status"
      aria-label="Fit view shortcut: press F to fit the whole graph"
      title="F fit view · ? shortcuts · Esc dismiss"
      onClick={dismiss}
      className="ix-fit-hint"
      data-visible={visible}
      style={{
        position: 'fixed',
        bottom: '18px',
        left: '50%',
        transform: visible ? 'translateX(-50%)' : 'translateX(-50%) translateY(6px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 14px',
        borderRadius: '10px',
        cursor: 'pointer',
        // Theme tokens with sensible dark-mode fallbacks; swap for the real
        // design-system hooks (useTheme / CSS vars) when integrating.
        background: 'var(--color-card, rgba(19, 26, 38, 0.95))',
        border: '1px solid var(--color-border, rgba(148, 163, 184, 0.35))',
        color: 'var(--color-foreground, #e2e8f0)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
        fontSize: '13px',
        lineHeight: '1.4',
        fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
        opacity: visible ? 1 : 0,
        transition: 'opacity 600ms ease, transform 600ms ease',
      }}
    >
      <kbd
        style={{
          fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
          fontSize: '11px',
          fontWeight: 600,
          padding: '2px 7px',
          borderRadius: '5px',
          background: 'var(--color-muted, rgba(148, 163, 184, 0.15))',
          border: '1px solid var(--color-border, rgba(148, 163, 184, 0.35))',
          color: 'var(--color-foreground, #e2e8f0)',
        }}
      >
        F
      </kbd>
      <span>fit view</span>
    </button>
  );
}

/** Endpoint the remap chip POSTs to (patched by the skill's apply.sh). */
export const REMAP_URL = '/__ix/remap';

/**
 * Trigger a code-map rebuild. Returns the parsed JSON body; throws on network
 * or HTTP errors. The endpoint blocks until the map finishes, so this resolves
 * only once the graph is ready to reload.
 */
export async function remapProject(url: string = REMAP_URL): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`remap failed: HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (body.ok === false) throw new Error(body.error || 'remap failed');
  return { ok: true };
}

export interface RunIxMapHintProps {
  /** Render only when the scoped workspace has no graph. */
  show: boolean;
  /** Endpoint override for tests / dev servers. */
  remapUrl?: string;
  /** Override the success behavior (default: reload the tab). */
  onMapped?: () => void;
  /** Injectable storage for the session-dismiss flag. */
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * "No map yet — run ix map" chip. Renders when `show` is true, POSTs
 * /__ix/remap on click, shows a Mapping state, and reloads on success.
 * Dismissal is session-only (the chip should keep offering the action until a
 * map actually exists — unlike the F hint, it is not remembered forever).
 */
export function RunIxMapHint({
  show,
  remapUrl = REMAP_URL,
  onMapped,
  sessionStorage: session = defaultSessionStorage,
}: RunIxMapHintProps) {
  const [mapping, setMapping] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    if (!session) return false;
    try {
      return session.getItem(SESSION_HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const run = useCallback(async () => {
    if (mapping) return;
    setMapping(true);
    setFailed(false);
    try {
      await remapProject(remapUrl);
      if (onMapped) onMapped();
      else window.location.reload();
    } catch {
      setMapping(false);
      setFailed(true);
    }
  }, [mapping, remapUrl, onMapped]);

  const dismiss = useCallback(() => {
    try {
      session?.setItem(SESSION_HIDE_KEY, '1');
    } catch {
      // Ignore — chip just reappears next load.
    }
    setDismissed(true);
  }, [session]);

  // Keyboard-dismissible: Escape hides the chip for the session (same as ×).
  useEffect(() => {
    if (!show || dismissed) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, dismissed, dismiss]);

  if (!show || dismissed) return null;

  const label = mapping ? 'Mapping…' : failed ? 'Map failed —' : 'No map yet';
  const sub = mapping ? 'this can take a while' : failed ? 'retry' : 'run ix map';

  return (
    <button
      type="button"
      role="status"
      aria-label={label + ' ' + sub}
      title="run ix map · F fit view · ? shortcuts · Esc hide"
      onClick={run}
      disabled={mapping}
      className="ix-run-ix-map-hint"
      style={{
        position: 'fixed',
        bottom: '18px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 14px',
        borderRadius: '10px',
        cursor: mapping ? 'default' : 'pointer',
        opacity: mapping ? 0.85 : 1,
        // Theme tokens with sensible dark-mode fallbacks; swap for the real
        // design-system hooks (useTheme / CSS vars) when integrating.
        background: 'var(--color-card, rgba(19, 26, 38, 0.95))',
        border: '1px solid var(--color-border, rgba(148, 163, 184, 0.35))',
        color: 'var(--color-foreground, #e2e8f0)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
        fontSize: '13px',
        lineHeight: '1.4',
        fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <span>{label}</span>
      <span style={{ fontWeight: 600 }}>{sub}</span>
      <span
        role="button"
        aria-label="Hide (until next load)"
        title="Hide (until next load)"
        onClick={(ev) => {
          ev.stopPropagation();
          dismiss();
        }}
        style={{ marginLeft: '6px', opacity: 0.55, fontSize: '15px', lineHeight: 1, cursor: 'pointer' }}
      >
        ×
      </span>
    </button>
  );
}

const SESSION_HIDE_KEY = 'ix-no-map-chip-hidden-v1';

const defaultSessionStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined =
  typeof sessionStorage === 'undefined' ? undefined : sessionStorage;

export default FitViewHint;
