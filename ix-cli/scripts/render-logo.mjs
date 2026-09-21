#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

// render-logo.mjs — render assets/logo.png as a terminal banner. Zero deps.
// The repo asset is the single source of truth; no hand-maintained art lives here.
//
// Algorithm (sharp pixel-art pipeline): the previous revision averaged the
// gradient inside each half-cell and emitted the averaged truecolor, which
// turned the mark into soft gradient mush. This revision keeps the
// coverage-supersampling idea but reproduces the sharp rendering:
//   1. decode the PNG by hand (chunks -> inflate -> unfilter types 0-4)
//   2. detect the backdrop as the modal color (bg-honesty for no-alpha PNGs)
//   3. tight-crop to the ink bounding box (+margin) — no rows spent on canvas
//   4. per pixel-row cell, ink coverage >= 0.5 snaps the cell to ink and the
//      cell color is the mean over INK pixels only (the backdrop never bleeds
//      in), so the boundary sits on the true 50%-coverage contour
//   5. the cell's normalized luminance snaps to a flat 5-tone brand ramp —
//      no in-between colors are ever emitted (the perceived sharpness)
//   6. half-block emit: adjacent pixel rows fuse into one character cell
//      (▀ fg=top / bg=bottom), run-length SGR, one reset per line
//
// Library use:
//   import { renderLogo } from "./ix-cli/scripts/render-logo.mjs";
//   const ansi = renderLogo({ width: 56, color: "truecolor" });   // -> string
//   const info = renderLogo({ width: 56, json: true });           // -> object
//
// CLI:
//   node scripts/render-logo.mjs [--width N] [--color auto|truecolor|256|ascii]
//                                 [--bg brand|none] [--file path] [--json]
// Exit codes: 0 ok · 1 usage/file error · 2 unsupported/truncated (toolscan-aligned)
import { openSync, closeSync, readSync, fstatSync, constants as fsConstants } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = "render-logo";
// Flat 5-tone brand ramp, hand-tuned to even perceptual-luminance steps from
// the asset's own gradient anchors (#002056 -> #3470D7 -> #53B3FF -> #D4F0FF).
// Every inked cell lands on exactly one tone; nothing between tones is emitted.
const PALETTE = [
  [0x00, 0x26, 0x5e], // T1 deep royal
  [0x0b, 0x4a, 0x9e], // T2 royal
  [0x24, 0x78, 0xd8], // T3 azure
  [0x58, 0xb4, 0xff], // T4 sky
  [0xd8, 0xf0, 0xff], // T5 ice
];
const PAL_L = PALETTE.map(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b); // 33,65,106,161,235
const SNAP_BOUNDS = [0, 1, 2, 3].map((i) => (PAL_L[i] + PAL_L[i + 1]) / 2); // 49,85.5,133.5,198
const ASCII_MAP = [".", "-", "=", "*", "#"]; // T1..T5 (dark -> dense on dark terminals)
const INK_DIST = 60;    // squared-distance threshold: ink iff |rgb-bg|^2 > 60^2
const COV_THRESHOLD = 0.5; // cell is ink at >=50% coverage — the honest contour
const LUM_LO = 26.0, LUM_HI = 233.5; // source ink-luminance normalization range
const CROP_MARGIN = 40; // breathing room around the ink bounding box (source px)
const ALPHA_EDGE = 128; // alpha PNGs: pixel counts as ink above this alpha
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const WIDTH_MIN = 8, WIDTH_MAX = 120, ROWS_MAX = 60;

export class LogoError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// --- PNG decode (depth 8, truecolor/truecolor+alpha/grayscale, no interlace) ---
// Read the input through ONE open handle: stat the handle, not the path.
// statSync(path)+readFileSync(path) resolve the path independently, so the size
// guard can bless a different file than the one read (CodeQL js/file-system-
// race, high), and readFileSync on a FIFO blocks forever — --file is a
// user-supplied flag, so both are reachable. O_NONBLOCK makes the open itself
// non-blocking; fstat on the handle then rejects non-regular files (FIFOs,
// devices) and enforces the size cap against the exact inode that is read.
function readPngFile(fileArg) {
  let fd;
  try { fd = openSync(fileArg, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); }
  catch { throw new LogoError(`file not found: ${fileArg}`, 1); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new LogoError(`not a regular file: ${fileArg}`, 1);
    if (st.size > MAX_FILE_BYTES) throw new LogoError(`file exceeds ${MAX_FILE_BYTES} bytes: ${fileArg}`, 2);
    const buf = Buffer.alloc(st.size);
    try {
      let read = 0;
      while (read < st.size) {
        const n = readSync(fd, buf, read, st.size - read, read);
        if (n === 0) break;
        read += n;
      }
    } catch (e) { throw new LogoError(`unreadable file: ${e.message}`, 1); }
    return { buf, bytes: st.size };
  } finally {
    closeSync(fd);
  }
}

function decodePng(fileArg) {
  const { buf, bytes } = readPngFile(fileArg);
  let off = 8, ihdr, idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new LogoError("not a PNG (no IHDR)", 2);
  const { w, h, depth, color, interlace } = ihdr;
  if (depth !== 8 || interlace !== 0 || ![0, 2, 6].includes(color)) {
    throw new LogoError(`unsupported PNG shape (depth=${depth} color=${color} interlace=${interlace})`, 2);
  }
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 1;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch (e) { throw new LogoError(`corrupt PNG (${e.message})`, 2); }
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new LogoError("truncated PNG data", 2);
  const img = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? img[y * stride + x - bpp] : 0;
      const up = y > 0 ? img[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= bpp ? img[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += left; else if (f === 2) v += up; else if (f === 3) v += (left + up) >> 1; else if (f === 4) v += paeth(left, up, ul);
      img[y * stride + x] = v & 0xff;
    }
  }
  return { img, w, h, stride, color, bpp, bytes };
}

// --- palette (ANSI-256) ---
// Nearest-256 by squared Euclidean distance over the FULL xterm table — the
// mapping the canonical goldens were generated with (Manhattan/cube+gray
// heuristics disagree on the backdrop rgb(0,0,27): cube-16 vs gray-232).
function xtermTable() {
  const lv = [0, 95, 135, 175, 215, 255];
  const t = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++)
    t.push([16 + 36 * r + 6 * g + b, lv[r], lv[g], lv[b]]);
  for (let k = 0; k < 24; k++) { const v = 8 + k * 10; t.push([232 + k, v, v, v]); }
  return t;
}
const XTERM = xtermTable();
function to256([r, g, b]) {
  let best = 16, bd = Infinity;
  for (const [idx, rr, gg, bb] of XTERM) {
    const d = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (d < bd) { bd = d; best = idx; }
  }
  return best;
}

export function resolveColorMode(colorArg, env = process.env) {
  if (colorArg !== "auto") {
    if (!["truecolor", "256", "ascii"].includes(colorArg)) throw new LogoError("--color must be auto|truecolor|256|ascii", 1);
    return colorArg;
  }
  if (env.NO_COLOR || env.TERM === "dumb") return "ascii";
  if (env.FORCE_COLOR === "0") return "ascii";
  if ((env.COLORTERM ?? "").includes("truecolor") || env.FORCE_COLOR === "3") return "truecolor";
  if (env.TERM && env.TERM !== "dumb") return "256";
  return "ascii";
}

// --- backdrop detection (bg-honesty: the modal color, sampled) ---
// The backdrop is a huge flat region, so the modal color of a sparse sample is
// stable — and it keeps the ink test honest if the brand navy ever shifts.
function detectBg(img, w, h) {
  const counts = new Map();
  const step = 7;
  for (let y = 0; y < h; y += step) {
    let i = y * w * 3;
    for (let x = 0; x < w; x += step, i += 3 * step) {
      const key = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let bestKey = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k; }
  return [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
}

// --- grid build: tight crop + coverage contour + ink-only mean + tone snap ---
// The grid holds one tone per PIXEL row cell (-1 = backdrop); adjacent pixel
// rows fuse into one half-block character cell at emit time, which is what
// keeps the full vertical resolution the sharp rendering was verified at.
function buildGrid(px, alpha, hasAlpha, w, h, bg, cols) {
  const bgR = bg[0], bgG = bg[1], bgB = bg[2];
  // ink test: alpha PNGs decide by alpha (a transparent pixel has no meaningful
  // RGB to measure); no-alpha PNGs by color distance from the detected
  // backdrop — an opaque backdrop pixel is BACKGROUND, not ink.
  const isInk = (i, ai) => (hasAlpha
    ? alpha[ai] > ALPHA_EDGE
    : (() => { const dr = px[i] - bgR, dg = px[i + 1] - bgG, db = px[i + 2] - bgB; return dr * dr + dg * dg + db * db > INK_DIST * INK_DIST; })());
  // ink bounding box -> tight crop: the full canvas spends ~21% of its rows on
  // empty backdrop; cropping spends every emitted cell on actual art.
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    let i = y * w * 3, ai = y * w;
    for (let x = 0; x < w; x++, i += 3, ai++) {
      if (isInk(i, ai)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new LogoError("no ink found (blank image?)", 2);
  x0 = Math.max(0, x0 - CROP_MARGIN); y0 = Math.max(0, y0 - CROP_MARGIN);
  x1 = Math.min(w - 1, x1 + CROP_MARGIN); y1 = Math.min(h - 1, y1 + CROP_MARGIN);
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;

  // rows counts PIXEL rows here (two per character row); even so half-block
  // pairs stay clean, and the character-row count stays within ROWS_MAX.
  let rows = Math.round((cols * chh) / cw);
  if (rows % 2) rows += 1;
  rows = Math.max(2, Math.min(ROWS_MAX * 2, rows));

  const xr = new Int32Array(cols + 1);
  for (let i = 0; i <= cols; i++) xr[i] = Math.min(cw, Math.floor((i * cw) / cols));
  const yr = new Int32Array(rows + 1);
  for (let j = 0; j <= rows; j++) yr[j] = Math.min(chh, Math.floor((j * chh) / rows));

  const grid = new Int8Array(cols * rows).fill(-1);
  for (let j = 0; j < rows; j++) {
    const ya = y0 + yr[j], yb = y0 + yr[j + 1] > ya ? y0 + yr[j + 1] : ya + 1;
    for (let i = 0; i < cols; i++) {
      const xa = x0 + xr[i], xb = x0 + xr[i + 1] > xa ? x0 + xr[i + 1] : xa + 1;
      let n = 0, inkn = 0, sr = 0, sg = 0, sb = 0;
      for (let y = ya; y < yb; y++) {
        let k = (y * w + xa) * 3, ai = y * w + xa;
        for (let x = xa; x < xb; x++, k += 3, ai++) {
          n++;
          if (isInk(k, ai)) { inkn++; sr += px[k]; sg += px[k + 1]; sb += px[k + 2]; }
        }
      }
      if (!n || inkn / n < COV_THRESHOLD) continue; // below the contour: backdrop
      const r = sr / inkn, g = sg / inkn, b = sb / inkn;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // normalize the asset's ink range into the ramp's span, then snap
      const ln = Math.min(1, Math.max(0, (lum - LUM_LO) / (LUM_HI - LUM_LO))) * (PAL_L[4] - PAL_L[0]) + PAL_L[0];
      let tone = 0;
      while (tone < 4 && ln >= SNAP_BOUNDS[tone]) tone++;
      grid[j * cols + i] = tone;
    }
  }
  return { grid, rows, crop: { x0, y0, x1, y1 } };
}

// --- emitters: half-blocks, run-length SGR, one reset per line ---
// A character cell fuses two grid rows: top tone t and bottom tone b.
//   both backdrop  -> ' '   (brand mode paints the backdrop behind it)
//   top only       -> '▀' fg=t (brand mode paints the backdrop behind it)
//   bottom only    -> '▄' fg=b (brand mode paints the backdrop behind it)
//   both inked     -> '▀' fg=t bg=b
function cellGlyph(t, b) {
  if (t < 0 && b < 0) return { ch: " ", fg: -1, bgk: -2 };
  if (t >= 0 && b < 0) return { ch: "▀", fg: t, bgk: -2 };
  if (t < 0 && b >= 0) return { ch: "▄", fg: b, bgk: -2 };
  return { ch: "▀", fg: t, bgk: b };
}

function emitColor(g, bg, mode, painted) {
  const { grid, rows } = g;
  const cols = grid.length / rows;
  const bg256 = to256(bg);
  const sgrFor = (tone) => (mode === "truecolor"
    ? `38;2;${PALETTE[tone][0]};${PALETTE[tone][1]};${PALETTE[tone][2]}`
    : `38;5;${to256(PALETTE[tone])}`);
  const sgrBgFor = (tone) => (mode === "truecolor"
    ? `48;2;${PALETTE[tone][0]};${PALETTE[tone][1]};${PALETTE[tone][2]}`
    : `48;5;${to256(PALETTE[tone])}`);
  const bgSgr = () => (mode === "truecolor" ? `48;2;${bg[0]};${bg[1]};${bg[2]}` : `48;5;${bg256}`);
  const lines = [];
  for (let j = 0; j < rows; j += 2) {
    let line = "", run = null;
    for (let i = 0; i < cols; i++) {
      const t = grid[j * cols + i];
      const b = j + 1 < rows ? grid[(j + 1) * cols + i] : -1;
      const { ch, fg, bgk } = cellGlyph(t, b);
      const sig = `${ch}/${fg}/${bgk}`;
      if (run && run.sig === sig) { run.n++; continue; }
      if (run) line += flush(run);
      run = { sig, ch, fg, bgk, n: 1 };
    }
    if (run) line += flush(run);
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");

  function flush(r) {
    const parts = [];
    if (r.fg >= 0) parts.push(sgrFor(r.fg));
    if (r.bgk >= 0) parts.push(sgrBgFor(r.bgk));
    else if (r.bgk === -2 && painted) parts.push(bgSgr());
    return (parts.length ? `\x1b[${parts.join(";")}m` : "") + r.ch.repeat(r.n);
  }
}

function emitAscii(g) {
  const { grid, rows } = g;
  const cols = grid.length / rows;
  const lines = [];
  for (let j = 0; j < rows; j += 2) {
    let line = "";
    for (let i = 0; i < cols; i++) {
      const t = grid[j * cols + i];
      const b = j + 1 < rows ? grid[(j + 1) * cols + i] : -1;
      const v = t >= 0 ? t : b;
      line += v < 0 ? " " : ASCII_MAP[v];
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

// --- render (library entry) ---
export function renderLogo(opts = {}) {
  const width = opts.width ?? 56;
  if (!Number.isInteger(width) || width < WIDTH_MIN || width > WIDTH_MAX) {
    throw new LogoError(`--width must be an integer ${WIDTH_MIN}..${WIDTH_MAX}`, 1);
  }
  const bgMode = opts.bg ?? "brand";
  if (!"brand none".split(" ").includes(bgMode)) throw new LogoError("--bg must be brand|none", 1);
  const fileArg = opts.file ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "logo.png");
  const { img, w, h, stride, color, bpp, bytes } = decodePng(fileArg);
  const mode = resolveColorMode(opts.color ?? "auto", opts.env);
  const painted = bgMode === "brand";

  // ink test over the SOURCE layout (alpha PNGs by alpha, no-alpha by color
  // distance from the backdrop); the grid math runs on normalized RGB planes
  // so it never branches on the source channel layout.
  const px = Buffer.alloc(w * h * 3);
  const alpha = color === 6 ? Buffer.alloc(w * h) : null;
  for (let y = 0; y < h; y++) {
    let q = y * w * 3;
    if (color === 2) img.copy(px, q, y * stride, (y + 1) * stride);
    else if (color === 0) for (let x = 0; x < w; x++) { const v = img[y * stride + x]; px[q++] = v; px[q++] = v; px[q++] = v; }
    else for (let x = 0; x < w; x++) { const s = y * stride + x * 4; px[q++] = img[s]; px[q++] = img[s + 1]; px[q++] = img[s + 2]; if (alpha) alpha[y * w + x] = img[s + 3]; }
  }
  const bg = detectBg(px, w, h);
  const g = buildGrid(px, alpha, color === 6, w, h, bg, width);

  let out;
  if (mode === "ascii") out = emitAscii(g);
  else out = emitColor(g, bg, mode, painted);
  out += "\n";

  if (opts.json) {
    const inkCells = countInkCharCells(g);
    return {
      ok: true, tool: TOOL, color: mode, bg: bgMode, file: { path: String(fileArg), bytes },
      source: { width: w, height: h }, grid: { cols: width, rows: g.rows / 2 },
      cells: { total: (g.rows / 2) * width, ink: inkCells }, truncated: false,
    };
  }
  return out;
}

// JSON counts character cells (the emitted unit), not pixel-row cells.
function countInkCharCells(g) {
  const { grid, rows } = g;
  const cols = grid.length / rows;
  let ink = 0;
  for (let j = 0; j < rows; j += 2) {
    for (let i = 0; i < cols; i++) {
      const t = grid[j * cols + i];
      const b = j + 1 < rows ? grid[(j + 1) * cols + i] : -1;
      if (t >= 0 || b >= 0) ink++;
    }
  }
  return ink;
}

// --- CLI (thin: parse, render, report) ---
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  const flagJson = () => args.includes("--json");
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null; // null = missing value
    return v;
  };
  const fail = (msg, code) => {
    if (flagJson()) process.stdout.write(`${JSON.stringify({ ok: false, tool: TOOL, error: msg })}\n`);
    else process.stderr.write(`${TOOL}: ${msg}\n`);
    process.exit(code);
  };
  const get = (name) => {
    const v = flag(name);
    if (v === null) fail(`missing value for ${name}`, 1);
    return v;
  };
  const bgRaw = get("--bg");
  if (bgRaw !== undefined && !"brand none".split(" ").includes(bgRaw)) fail("--bg must be brand|none", 1);
  try {
    const result = renderLogo({
      width: flag("--width") !== undefined ? Number(get("--width")) : 56,
      color: get("--color") ?? "auto",
      bg: bgRaw ?? "brand",
      file: get("--file"),
      json: flagJson(),
    });
    process.stdout.write(typeof result === "string" ? result : `${JSON.stringify(result)}\n`);
  } catch (e) {
    fail(e instanceof LogoError ? e.message : e.message, e instanceof LogoError ? e.code : 1);
  }
}
