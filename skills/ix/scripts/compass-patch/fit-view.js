/* Ix Compass — "Fit view" patch.
 *
 * Adds:
 *  - Auto-frame on first render: centers the viewport on the node graph so the
 *    initial load never shows an empty canvas corner (the built-in default pans
 *    to an empty region on some graphs).
 *  - Keyboard: F / f = fit the whole node graph into the viewport (animated).
 *    Listed in the built-in keyboard-help pane (patched by apply.sh).
 *  - Re-frames automatically when the node set changes (drill in/out).
 *  - Live theme re-sampling: the chips listen to prefers-color-scheme AND the
 *    app's own `dark`-class toggle, and re-apply their sampled tokens the
 *    moment the theme changes — no reload needed.
 *
 * This works purely on the DOM: the app owns the pan/zoom transform, and this
 * script only reframes it. The app re-renders the transform on user actions,
 * so F is always available to reframe.
 *
 * Re-apply after every `ix upgrade` — the installer wipes the Compass dir.
 * The skill's bootstrap.sh / bootstrap.ps1 do this automatically; to apply
 * manually: bash skills/ix/scripts/compass-patch/apply.sh
 */
(function () {
  'use strict';

  var READABLE_FLOOR = 0.05; // never zoom below this in the auto-frame
  var MIN_FIT = 0.01;        // absolute floor for the F fit-view

  function canvasEl() { return document.querySelector('.ix-crisp-canvas'); }
  function wrapEl() { var c = canvasEl(); return c && c.parentElement; }

  function isNodeCard(d) {
    var s = d.getAttribute('style') || '';
    return /left: -?\d+(\.\d+)?px/.test(s) && /top: -?\d+(\.\d+)?px/.test(s);
  }

  function nodeBox() {
    var canvas = canvasEl();
    if (!canvas) return null;
    var cards = Array.prototype.slice.call(canvas.querySelectorAll('div')).filter(isNodeCard);
    if (!cards.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    cards.forEach(function (c) {
      var s = c.getAttribute('style');
      var m = s.match(/left: (-?[\d.]+)px/); var l = m ? parseFloat(m[1]) : 0;
      m = s.match(/top: (-?[\d.]+)px/); var t = m ? parseFloat(m[1]) : 0;
      minX = Math.min(minX, l); maxX = Math.max(maxX, l + c.offsetWidth);
      minY = Math.min(minY, t); maxY = Math.max(maxY, t + c.offsetHeight);
    });
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }

  // target: 'fit' = whole graph overview; 'readable' = centered, floored zoom.
  function frame(target, animate) {
    var canvas = canvasEl(), wrap = wrapEl(), box = nodeBox();
    if (!canvas || !wrap || !box || !box.w || !box.h) return false;
    var fit = Math.min((window.innerWidth - 80) / box.w, (window.innerHeight - 140) / box.h);
    var zoom = target === 'fit'
      ? Math.max(MIN_FIT, fit)
      : Math.max(READABLE_FLOOR, Math.min(0.5, fit * 1.5));
    var tx = window.innerWidth / 2 - box.cx * zoom;
    var ty = window.innerHeight / 2 - box.cy * zoom;

    var fromZoom = parseFloat(canvas.style.zoom) || zoom;
    var fromTx = 0, fromTy = 0;
    var m = (wrap.getAttribute('style') || '').match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
    if (m) { fromTx = parseFloat(m[1]); fromTy = parseFloat(m[2]); }

    function apply(z, x, y) {
      canvas.style.zoom = String(z);
      wrap.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
      wrap.style.transformOrigin = '0px 0px';
    }
    if (!animate) { apply(zoom, tx, ty); return true; }

    var start = performance.now(), dur = 240;
    (function tick(now) {
      var p = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - p, 2.4); // ease-out
      apply(fromZoom + (zoom - fromZoom) * e,
            fromTx + (tx - fromTx) * e,
            fromTy + (ty - fromTy) * e);
      if (p < 1) {
        requestAnimationFrame(tick);
      } else {
        // A React render can overwrite the inline transform right after the
        // animation (e.g. during mount churn); verify the target stuck and
        // re-apply non-animated if it was clobbered.
        setTimeout(function () {
          var curZ = parseFloat(canvas.style.zoom) || 0;
          var cm = (wrap.getAttribute('style') || '').match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
          var curX = cm ? parseFloat(cm[1]) : 0;
          if (Math.abs(curZ - zoom) > 0.001 || Math.abs(curX - tx) > 1) apply(zoom, tx, ty);
        }, 60);
      }
    })(start);
    return true;
  }

  function inInput() {
    var t = (document.activeElement || {}).tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  function onKeyDown(ev) {
    if ((ev.key === 'F' || ev.key === 'f') && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !inInput()) {
      ev.preventDefault();
      frame('fit', true);
    }
  }

  // --- Keydown arming --------------------------------------------------------
  // The app runs an entrance animation on mount and applies its initial camera
  // shortly after; a keypress in that window can be clobbered by a later React
  // render of the wrapper transform. Arm the F-key listener only once the
  // canvas animation has settled (poll getAnimations, capped at 3s).
  var keydownArmed = false;
  function armKeydown() {
    if (keydownArmed) return;
    var settleStart = performance.now();
    var st = setInterval(function () {
      var busy = false;
      try {
        busy = document.getAnimations().some(function (a) {
          var t = a && a.effect && a.effect.target;
          return t && t.closest && !!t.closest('.ix-crisp-canvas');
        });
      } catch (e) { busy = true; }
      var elapsed = performance.now() - settleStart;
      if ((!busy && elapsed > 400) || elapsed > 3000) {
        clearInterval(st);
        keydownArmed = true;
        window.addEventListener('keydown', onKeyDown);
      }
    }, 100);
  }

  // --- First-run hint chip --------------------------------------------------
  // A small "F = fit view" chip shown once on first load; auto-fades, is
  // click-to-dismiss, and is remembered per origin so it never nags again.
  var HINT_KEY = 'ix-fit-view-hint-seen-v1';
  var hintTimer = null;

  function hintColors() {
    // Prefer the app's theme tokens as CSS variables on <html>: they flip
    // INSTANTLY when the `dark` class toggles (no transition, no element
    // churn), so a live re-sample is race-free. Fall back to sampling a card
    // element's computed style when the variables aren't exposed.
    var root = getComputedStyle(document.documentElement);
    var card = root.getPropertyValue('--card').trim();
    var border = root.getPropertyValue('--border').trim();
    var fg = root.getPropertyValue('--foreground').trim();
    if (card && border && fg) {
      return {
        bg: 'hsl(' + card + ' / 0.95)',
        border: 'hsl(' + border + ')',
        fg: 'hsl(' + fg + ')',
      };
    }
    var sample = document.querySelector('[class*="rounded-xl"], [class*="bg-card"]');
    if (!sample) {
      return { bg: 'rgba(19,26,38,0.95)', border: 'rgba(148,163,184,0.35)', fg: '#e2e8f0' };
    }
    var cs = getComputedStyle(sample);
    return { bg: cs.backgroundColor, border: cs.borderColor, fg: cs.color };
  }

  // Apply sampled theme colors to a chip (and its <kbd>, if any). Used at
  // creation and re-applied when the app theme changes live.
  function applyChipColors(chip, c) {
    if (!chip) return;
    chip.style.background = c.bg;
    chip.style.border = '1px solid ' + c.border;
    chip.style.color = c.fg;
    var kbd = chip.querySelector('kbd');
    if (kbd) {
      kbd.style.border = '1px solid ' + c.border;
      kbd.style.color = c.fg;
    }
  }

  // Re-sample the sampled card tokens onto whichever chip is visible. Runs on
  // OS prefers-color-scheme changes and on the app's own theme toggle (which
  // flips the `dark` class on <html>), so an open chip matches the new theme
  // without a reload.
  //
  // Reading the tokens from CSS variables on <html> is race-free (they flip
  // synchronously with the class). The element-sampling fallback path needs
  // one rAF so getComputedStyle reflects the new class before we read it.
  function resampleChipTheme() {
    var c = hintColors();
    var usesVars = /hsl\(/.test(c.bg);
    if (usesVars) {
      applyChipColors(document.getElementById('ix-fit-hint'), c);
      applyChipColors(noMapChip, c);
      return;
    }
    requestAnimationFrame(function () {
      var c2 = hintColors();
      applyChipColors(document.getElementById('ix-fit-hint'), c2);
      applyChipColors(noMapChip, c2);
    });
  }

  function showHint() {
    if (typeof localStorage === 'undefined' || localStorage.getItem(HINT_KEY)) return;
    if (document.getElementById('ix-fit-hint')) return;
    var c = hintColors();
    var chip = document.createElement('div');
    chip.id = 'ix-fit-hint';
    chip.setAttribute('role', 'status');
    chip.title = 'F fit view · ? shortcuts · Esc dismiss';
    var kbd = document.createElement('kbd');
    kbd.textContent = 'F';
    var label = document.createElement('span');
    label.textContent = 'fit view';
    chip.appendChild(kbd);
    chip.appendChild(label);
    Object.assign(chip.style, {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '9999', display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 14px', borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
      fontSize: '13px', lineHeight: '1.4',
      fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
      transition: 'opacity 600ms ease, transform 600ms ease', cursor: 'pointer',
    });
    applyChipColors(chip, c);
    Object.assign(kbd.style, {
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: '11px', fontWeight: '600', padding: '2px 7px',
      background: 'rgba(148,163,184,0.15)',
      borderRadius: '5px',
    });
    // kbd border/color are applied via applyChipColors(chip, ...) above and on
    // theme resample; its muted keycap background intentionally stays constant
    // (mirrors the upstream --color-muted keycap) so it never goes stale.
    function dismiss() {
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {}
      clearTimeout(hintTimer);
      chip.style.opacity = '0';
      chip.style.transform = 'translateX(-50%) translateY(6px)';
      setTimeout(function () { chip.remove(); }, 650);
    }
    chip.addEventListener('click', dismiss);
    document.body.appendChild(chip);
    hintTimer = setTimeout(dismiss, 7000); // auto fade after 7s
  }

  // --- No-map chip ----------------------------------------------------------
  // When the scoped workspace has no graph, Compass renders a static
  // "Compass not connected to a codebase — Run `ix map .`" empty state with
  // no action. Surface an actionable chip: "No map yet — run ix map". Clicking
  // it POSTs /__ix/remap (a real handler added to the visualizer server by
  // apply.sh — the stock endpoint was a stub that returned the SPA HTML),
  // shows a Mapping state, and reloads the tab when the rebuild completes.
  var NO_MAP_KEY = 'ix-no-map-chip-hidden-v1';
  var noMapChip = null;
  var mapping = false;

  function dismissNoMapChip() {
    if (!noMapChip) return;
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(NO_MAP_KEY, '1'); } catch (e) {}
    noMapChip.remove();
    noMapChip = null;
  }

  // Escape dismisses whichever chip is visible (F hint or no-map). Bound once
  // up front — the chip can appear before the F keydown is armed.
  window.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || inInput()) return;
    if (noMapChip) { dismissNoMapChip(); return; }
    var hint = document.getElementById('ix-fit-hint');
    if (hint) { hint.click(); }
  });

  function emptyStateVisible() {
    var t = document.body && document.body.innerText || '';
    return t.indexOf('Compass not connected to a codebase') !== -1;
  }

  function noMapColors() { return hintColors(); }

  function showNoMapChip() {
    if (noMapChip || mapping) return;
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(NO_MAP_KEY)) return;
    var c = noMapColors();
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'ix-no-map-chip';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-label', 'No map yet — run ix map');
    chip.title = 'run ix map · F fit view · ? shortcuts · Esc hide';
    var label = document.createElement('span');
    label.textContent = 'No map yet';
    var action = document.createElement('span');
    action.textContent = 'run ix map';
    action.style.fontWeight = '600';
    chip.appendChild(label);
    chip.appendChild(action);
    Object.assign(chip.style, {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '9999', display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 14px', borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
      fontSize: '13px', lineHeight: '1.4',
      fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif', cursor: 'pointer',
    });
    applyChipColors(chip, c);
    chip.addEventListener('click', function (ev) {
      if (ev.target && ev.target === dismissBtn) return;
      runMap();
    });
    var dismissBtn = document.createElement('span');
    dismissBtn.textContent = '×';
    dismissBtn.title = 'Hide (until next load)';
    Object.assign(dismissBtn.style, {
      marginLeft: '6px', opacity: '0.55', fontSize: '15px', padding: '0 2px',
      cursor: 'pointer', lineHeight: '1',
    });
    dismissBtn.addEventListener('click', function (ev) { ev.stopPropagation(); dismissNoMapChip(); });
    chip.appendChild(dismissBtn);
    document.body.appendChild(chip);
    noMapChip = chip;
  }

  function setNoMapChipText(primary, secondary) {
    if (!noMapChip) return;
    var spans = noMapChip.querySelectorAll('span');
    if (spans[0]) spans[0].textContent = primary;
    if (spans[1]) spans[1].textContent = secondary;
  }

  function runMap() {
    if (mapping || !noMapChip) return;
    mapping = true;
    setNoMapChipText('Mapping…', 'this can take a while');
    noMapChip.style.opacity = '0.85';
    fetch('/__ix/remap', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { return {}; });
      })
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || 'map failed');
        location.reload(); // pick up the freshly built graph
      })
      .catch(function (err) {
        mapping = false;
        setNoMapChipText('Map failed —', 'retry');
        noMapChip.style.opacity = '1';
        console.error('[ix-fit-view] remap failed:', err);
      });
  }

  // --- Appearance timing (debug) ------------------------------------------
  // With the debug flag set (URL `?ix_fitview_debug=1` or localStorage key
  // `ix-fit-view-debug` = "1"), log the chip-appearance timing exactly once so
  // regressions in the 400ms detection poll below are observable in the
  // console: a chip that never appears, or one that only appears after the
  // 12s give-up fallback, will show a tell-tale timestamp / try count.
  var DEBUG_APPEARANCE =
    (typeof localStorage !== 'undefined' && localStorage.getItem('ix-fit-view-debug') === '1') ||
    /[?&]ix_fitview_debug=1/.test(window.location.search || '');
  var appearanceLogged = false;
  function logAppearance(kind, failedTries) {
    if (!DEBUG_APPEARANCE || appearanceLogged) return;
    appearanceLogged = true;
    console.info('[ix-fit-view] chip appeared: ' + kind + ' at ' +
      Math.round(performance.now()) + 'ms after navigation start (poll failed ' +
      failedTries + ' times at 400ms interval)');
  }

  // Auto-frame once the graph renders (fixes the empty-canvas first paint);
  // show the hint and arm the F key at the same moment. If the graph never
  // renders (no map for this workspace), surface the run-ix-map chip instead.
  var tries = 0;
  var emptyHits = 0;
  var iv = setInterval(function () {
    if (frame('readable', false)) {
      clearInterval(iv); showHint(); armKeydown();
      logAppearance('fit-hint', tries);
    }
    else if (emptyStateVisible()) {
      // Require 2 consecutive empty-state observations (~800ms) before
      // committing the chip, so a transient empty render (slow backend blip,
      // mid-remap reload) never sticks a permanent "run ix map" chip over a
      // graph that then appears. Genuinely empty workspaces still get the
      // chip within ~1s.
      if (++emptyHits >= 2) {
        clearInterval(iv); showNoMapChip();
        logAppearance('no-map-chip', tries);
      }
    }
    else {
      emptyHits = 0;
      if (++tries > 30) {
        clearInterval(iv);
        if (emptyStateVisible()) { showNoMapChip(); logAppearance('no-map-chip (give-up)', tries); }
      }
    }
  }, 400);

  // --- Live theme re-sampling ----------------------------------------------
  // The app follows the OS prefers-color-scheme and also has its own sun/moon
  // toggle that flips a `dark` class on <html>. Listen to both so an open chip
  // re-samples its tokens the moment the theme changes — no reload needed.
  var lastDark = document.documentElement && document.documentElement.classList.contains('dark');
  var mqDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mqDark && mqDark.addEventListener) {
    mqDark.addEventListener('change', resampleChipTheme);
  } else if (mqDark && mqDark.addListener) {
    mqDark.addListener(resampleChipTheme); // legacy Safari
  }
  var themeObs = new MutationObserver(function () {
    var dark = document.documentElement && document.documentElement.classList.contains('dark');
    if (dark === lastDark) return; // unrelated class churn — skip
    lastDark = dark;
    resampleChipTheme();
  });
  if (document.documentElement) {
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  // Re-frame when the node set changes (drill in/out, late data loads).
  var count = -1, timer = null;
  var obs = new MutationObserver(function () {
    var canvas = canvasEl();
    if (!canvas) return;
    var n = canvas.querySelectorAll('div').length;
    if (n === count) return;
    count = n;
    clearTimeout(timer);
    timer = setTimeout(function () { frame('readable', false); }, 500);
  });
  var canvas = canvasEl();
  if (canvas) obs.observe(canvas, { childList: true, subtree: true });

  window.__ixFitView = {
    frame: frame,
    armKeydown: armKeydown,
    isArmed: function () { return keydownArmed; },
    runMap: runMap,
    noMapChipVisible: function () { return !!noMapChip; },
    dismissNoMapChip: dismissNoMapChip,
    debugAppearance: DEBUG_APPEARANCE,
    appearanceLogged: function () { return appearanceLogged; },
  };
})();
