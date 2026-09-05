#!/usr/bin/env node
// render-logo.mjs — render assets/logo.png as a terminal banner. Zero deps.
// The repo asset is the single source of truth; no hand-maintained art lives here.
//
// Algorithm: coverage-thresholded supersampling. Each half-cell samples the
// source at bounded supersample density, counts ink coverage (alpha > 128, or
// for no-alpha PNGs color distance from the backdrop), snaps to ink at a low
// threshold (sharp shape boundaries), and averages color only over covered
// pixels (the brand gradient stays sharp inside the mark).
//
// Library use:
//   import { renderLogo } from "./scripts/render-logo.mjs";
//   const ansi = renderLogo({ width: 56, color: "truecolor" });   // -> string
//   const info = renderLogo({ width: 56, json: true });           // -> object
//
// CLI:
//   node scripts/render-logo.mjs [--width N] [--color auto|truecolor|256|ascii]
//                                 [--bg brand|none] [--file path] [--json]
// Exit codes: 0 ok · 1 usage/file error · 2 unsupported/truncated (toolscan-aligned)
import { readFileSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = "render-logo";
const BG = [5, 10, 30];            // brand navy (assets/logo.png backdrop)
const INK_COVERAGE = 0.12;          // snap-to-ink threshold per half-cell
const ALPHA_EDGE = 128;             // pixel counts as ink above this alpha
const BG_TOL = 36;                  // no-alpha PNGs: pixel is ink when its color
                                    // distance from the backdrop exceeds this
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const WIDTH_MIN = 8, WIDTH_MAX = 120, ROWS_MAX = 60;
const RAMP = " .:-=+*#%@";

export class LogoError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// --- PNG decode (depth 8, truecolor/truecolor+alpha/grayscale, no interlace) ---
function decodePng(fileArg) {
  let stat;
  try { stat = statSync(fileArg); } catch { throw new LogoError(`file not found: ${fileArg}`, 1); }
  if (stat.size > MAX_FILE_BYTES) throw new LogoError(`file exceeds ${MAX_FILE_BYTES} bytes: ${fileArg}`, 2);
  let buf;
  try { buf = readFileSync(fileArg); } catch (e) { throw new LogoError(`unreadable file: ${e.message}`, 1); }
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
  return { img, w, h, stride, color, bpp, bytes: stat.size };
}

// --- palette (ANSI-256) ---
const Q = [0, 95, 135, 175, 215, 255];
const pal256 = (i) => (i < 16 ? [[0,0,0],[128,0,0],[0,128,0],[128,128,0],[0,0,128],[128,0,128],[0,128,128],[192,192,192],[128,128,128],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]][i]
  : i < 232 ? [Q[Math.floor((i - 16) / 36)], Q[Math.floor((i - 16) / 6) % 6], Q[(i - 16) % 6]]
  : (() => { const v = 8 + (i - 232) * 10; return [v, v, v]; })());
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
function to256(rgb) {
  const qi = (v) => Q.reduce((best, qv, i) => (Math.abs(qv - v) < Math.abs(Q[best] - v) ? i : best), 0);
  const cube = 16 + 36 * qi(rgb[0]) + 6 * qi(rgb[1]) + qi(rgb[2]);
  const gray = 232 + Math.min(23, Math.round((0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 * 23));
  return dist(rgb, pal256(cube)) <= dist(rgb, pal256(gray)) ? cube : gray;
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

  // ink test: alpha PNGs decide by alpha; no-alpha PNGs by color distance from
  // the backdrop (an opaque navy pixel is BACKGROUND, not ink — color type 2
  // reports alpha 255 for every pixel, so alpha alone would mark the whole
  // canvas ink and blur the banner).
  const isInk = (i) => (color === 6
    ? img[i + 3] > ALPHA_EDGE
    : Math.abs(img[i] - BG[0]) + Math.abs(img[i + 1] - BG[1]) + Math.abs(img[i + 2] - BG[2]) > BG_TOL);

  function halfCell(x0, x1, y0, y1) {
    const sx = Math.max(1, Math.min(12, Math.floor((x1 - x0) / 3) || 1));
    const sy = Math.max(1, Math.min(12, Math.floor((y1 - y0) / 3) || 1));
    let covered = 0, samples = 0, r = 0, g = 0, b = 0;
    for (let y = y0; y < Math.max(y1, y0 + 1); y += sy)
      for (let x = x0; x < Math.max(x1, x0 + 1); x += sx) {
        const i = y * stride + x * bpp;
        samples++;
        if (!isInk(i)) continue;
        covered++;
        r += img[i]; g += img[i + 1]; b += img[i + 2];
      }
    const cov = covered / Math.max(1, samples);
    if (cov < INK_COVERAGE) return { ink: false, rgb: BG, lum: 0, cov };
    const k = covered || 1;
    const rgb = [r / k, g / k, b / k];
    return { ink: true, rgb, lum: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], cov };
  }

  const rows = Math.max(2, Math.min(ROWS_MAX, Math.round((width * h) / w / 2)));
  const cells = [];
  for (let ry = 0; ry < rows; ry++)
    for (let rx = 0; rx < width; rx++) {
      const x0 = Math.floor((rx * w) / width), x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * w) / width));
      const top = halfCell(x0, x1, Math.floor(((ry * 2) * h) / (rows * 2)), Math.max(1, Math.floor((((ry * 2) + 1) * h) / (rows * 2))));
      const bot = halfCell(x0, x1, Math.floor((((ry * 2) + 1) * h) / (rows * 2)), Math.max(1, Math.floor((((ry * 2) + 2) * h) / (rows * 2))));
      cells.push({ top, bot });
    }

  let out = "";
  let lastSig = "";
  for (let i = 0; i < cells.length; i++) {
    const { top, bot } = cells[i];
    if (i % width === 0) out += "\n";
    if (!top.ink && !bot.ink) { out += " "; lastSig = ""; continue; }
    if (mode === "ascii") {
      const intensity = Math.max(top.cov * (top.lum / 255), bot.cov * (bot.lum / 255)) * 1.6;
      out += RAMP[Math.min(RAMP.length - 1, Math.max(top.ink || bot.ink ? 1 : 0, Math.round(intensity * (RAMP.length - 1))))];
      continue;
    }
    if (bgMode === "none") {
      // Per-shape emission: paint only the half-cells that carry ink, never the
      // backdrop. A top-only cell is ▀ with fg=top and no background; a
      // bottom-only cell is ▄ with fg=bot; a full cell paints ▀ with fg=top,
      // bg=bot exactly like brand mode. The block stays the brand shape's own
      // pixels — nothing is drawn behind it.
      const fTop = mode === "truecolor"
        ? `38;2;${top.rgb.map((v) => Math.round(v)).join(";")}`
        : `38;5;${to256(top.rgb)}`;
      const fBot = mode === "truecolor"
        ? `38;2;${bot.rgb.map((v) => Math.round(v)).join(";")}`
        : `38;5;${to256(bot.rgb)}`;
      if (top.ink && bot.ink) {
        const sig = mode === "truecolor" ? `${top.rgb.map(Math.round)}/${bot.rgb.map(Math.round)}` : `${to256(top.rgb)}/${to256(bot.rgb)}`;
        if (sig !== lastSig) { out += `\x1b[0;${fTop};${fBot}m`; lastSig = sig; }
        out += "▀";
      } else if (top.ink) {
        const sig = mode === "truecolor" ? `${top.rgb.map(Math.round)}/-` : `${to256(top.rgb)}/-`;
        if (sig !== lastSig) { out += `\x1b[0;${fTop}m`; lastSig = sig; }
        out += "▀";
      } else {
        const sig = mode === "truecolor" ? `-${bot.rgb.map(Math.round)}` : `-${to256(bot.rgb)}`;
        if (sig !== lastSig) { out += `\x1b[0;${fBot}m`; lastSig = sig; }
        out += "▄";
      }
      continue;
    }
    const sig = mode === "truecolor"
      ? `${top.rgb.map(Math.round)}/${bot.rgb.map(Math.round)}`
      : `${to256(top.rgb)}/${to256(bot.rgb)}`;
    if (sig !== lastSig) {
      const f = mode === "truecolor"
        ? `38;2;${top.rgb.map((v) => Math.round(v)).join(";")}`
        : `38;5;${to256(top.rgb)}`;
      const b = mode === "truecolor"
        ? `48;2;${bot.rgb.map((v) => Math.round(v)).join(";")}`
        : `48;5;${to256(bot.rgb)}`;
      out += `\x1b[0;${f};${b}m`;
      lastSig = sig;
    }
    out += "▀";
  }
  if (mode !== "ascii") out += "\x1b[0m"; // no escapes at all under NO_COLOR/ascii
out += "\n";

  if (opts.json) {
    const inkCells = cells.filter((c) => c.top.ink || c.bot.ink).length;
    return {
      ok: true, tool: TOOL, color: mode, bg: bgMode, file: { path: String(fileArg), bytes },
      source: { width: w, height: h }, grid: { cols: width, rows },
      cells: { total: cells.length, ink: inkCells }, truncated: false,
    };
  }
  return out;
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
