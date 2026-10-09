#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

// check-links.mjs — verify every reference in the repo's markdown:
//   * absolute URLs resolve (fail on 404/410),
//   * relative links point at a tracked file (fail when the file is renamed
//     or removed — same breakage class as a dead URL), in markdown link
//     syntax and in HTML src/href attributes alike.
// Zero dependencies (Node 22+ global fetch). Mirror of the api-parity gate:
// same shape, same exit discipline — `ok` is not assumed, it is measured.
//
// Classification:
//   2xx/3xx                      OK
//   404/410 (or missing file)    ERROR — fails the gate
//   other 4xx/5xx                warning (usually bot-blocking, e.g.
//                                desktop.docker.com answers 403 to anything
//                                without a browser)
//   network failure              warning (flaky CI network; not a fact)
//
// Skipped: localhost/127.0.0.1/0.0.0.0 (dev servers), mailto:. Anchors are
// checked too: a #fragment must match a heading slug on the target page,
// using GitHub-style slugs — the same ones GitHub and Starlight render.
//
// Two surfaces, one pass. Files under docs-site/src/content/docs/ render as
// site routes, so a root-relative target there is checked against the route
// space — the tracked content tree plus the pages sync-reference.mjs
// generates (declared in docs-site/.gitignore) and the api/endpoints/* pages
// starlight-openapi generates from docs/api/openapi.yaml. Everywhere else a
// root-relative target is checked against the repo root, which is where
// GitHub resolves it. `.mdx` files are scanned like `.md`: the docs-site
// pages are MDX, and their markdown links and component href attributes were
// invisible to this gate while the filter was `.md` only.
//
// Fenced code blocks are scanned like prose: install instructions and
// documented endpoints live in fences (docs/prerequisites.md carries the
// egress allowlist entirely inside one), so dropping them hid exactly the
// URLs that matter. Genuine illustrations that die get an allowlist entry,
// and the stale-entry check removes it once the URL leaves the tree.
//
// Built-dist mode: `--dist <dir>` (opt-in) additionally crawls a BUILT
// docs-site dist/ — the shipped output — so a route the build dropped or a
// page the template broke is caught even when every tracked source resolves.
// Allowlist: only links known-dead with a tracked replacement. Keys are
// normalized through the same URL normalization the extractor uses, so a
// trailing-slash variant of an allowed URL cannot false-fail. An allow entry
// that no longer appears in any scanned file is itself an ERROR — a stale
// allowlist must not rot silently.
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Empty, and that is the intended steady state.
//
// It carried two entries while #582 and #589 were open — the dead backend-repo
// link in CONTRIBUTING.md and the dead Docs nav link in README.md. Both merged,
// so both URLs are gone from the tree, and the stale-entry check below did
// exactly what it exists to do: it failed this branch until the entries were
// removed. Anything added here must name the PR that retires it, because an
// entry that outlives its URL is itself an error.
const ALLOW = new Map([]);

const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const TIMEOUT_MS = 10000;

// One normalization owner: both the allowlist keys and the extracted URLs go
// through this, so `…/docs` and `…/docs/` are the same reference (GitHub
// treats them as one page). A single trailing slash is stripped; the root
// keeps its slash.
const normUrl = (u) => {
  const h = new URL(u).href;
  return h.endsWith('/') && new URL(h).pathname !== '/' ? h.slice(0, -1) : h;
};
const ALLOW_NORM = new Map([...ALLOW].map(([k, reason]) => [normUrl(k), reason]));

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

function extractUrls(text) {
  const re = /https?:\/\/[^\s)<>"'\]]+/g;
  const out = new Set();
  for (const m of text.matchAll(re)) {
    let u = m[0].replace(/[.,;:!?]+$/, '');
    try { u = new URL(u).href; } catch { continue; }
    if (SKIP_HOSTS.has(new URL(u).hostname)) continue;
    out.add(u);
  }
  return [...out];
}

// Link targets in the three forms this repo's markdown uses: `[text](path)`,
// `[ref]: path`, and HTML attributes — `<img src="path">`, `<a href="path">`.
// Root-relative targets are kept: they are site routes in docs content and
// repo-root paths everywhere else, and both are checked (see checkReference).
//
// The HTML form is not a nicety. A README opens with a centred `<p>` block
// because markdown cannot centre an image, so every banner, logo and demo in
// this repo is an HTML `src` and none of them were scanned: Ix#605 moved
// assets/logo.png into ix-cli/ and the README's logo 404'd on the front page
// of the project while this gate stayed green. Absolute URLs inside these
// attributes were always covered — extractUrls() matches on `https?://`
// wherever it appears — so this closes the relative half only.
function extractRelativeTargets(text) {
  const targets = [];
  const take = (raw, image = false) => {
    const t = raw.trim();
    if (isExternal(t)) return;
    targets.push({ target: t, image });
  };
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)]+)\)/g)) take(m[2], m[1] === '!');
  for (const m of text.matchAll(/^\[[^\]]*\]:\s*(\S+)/gm)) take(m[1].replace(/^<|>$/g, ''));
  for (const m of text.matchAll(/<[a-zA-Z][^>]*?\s(src|href)\s*=\s*["']([^"']+)["']/g)) take(m[2], m[1] === 'src');
  return targets;
}
function isExternal(t) {
  // Protocol-relative (//host) and scheme URLs (https:, mailto:, …) are not
  // filesystem targets. A single leading `/` is one, so it is not skipped.
  return !t || t.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(t);
}

async function probe(url) {
  // HEAD first; a 405 means the server rejects HEAD, so retry GET once.
  const attempt = async (method) => {
    try {
      const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: r.status, network: false };
    } catch (e) {
      return { status: 0, network: true, error: String(e.cause?.code || e.message) };
    }
  };
  let res = await attempt('HEAD');
  if (res.status === 405) res = await attempt('GET');
  return res;
}

const allFiles = trackedFiles();
const mdFiles = allFiles.filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
const allSet = new Set(allFiles);
const allLower = new Set(allFiles.map((f) => f.toLowerCase()));

function targetExists(target, file) {
  let t = target.split('#')[0].split('?')[0];
  if (!t) return true; // pure anchor
  let resolved;
  try {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(t)));
  } catch { return true; } // malformed escape — leave to a link checker that parses
  if (allSet.has(resolved) || allLower.has(resolved.toLowerCase())) return true;
  // A directory target is fine if any tracked file lives under it.
  const prefix = resolved.endsWith('/') ? resolved : resolved + '/';
  return [...allLower].some((f) => f.startsWith(prefix.toLowerCase()));
}

// ---- docs-site route space -------------------------------------------------
// A link inside docs-site content is a site link, not a repo path. The site
// is built from the content tree plus generated pages, so root-relative and
// page-relative targets there resolve against routes, not files. The
// generated-page list lives in docs-site/.gitignore (tracked), which is the
// one place sync-reference.mjs's outputs are declared.
const DOCS_CONTENT = 'docs-site/src/content/docs/';
const OPENAPI_ROUTE_PREFIX = '/api/endpoints/';
const docsRoutes = new Set();
const docsRouteFile = new Map();

function docsRouteOf(contentRel) {
  let r = contentRel.replace(/\.(md|mdx)$/, '');
  if (r === 'index') r = '';
  else if (r.endsWith('/index')) r = r.slice(0, -'/index'.length);
  return '/' + r + (r ? '/' : '');
}

for (const f of allFiles) {
  if (!f.startsWith(DOCS_CONTENT) || !/\.(md|mdx)$/.test(f)) continue;
  const route = docsRouteOf(f.slice(DOCS_CONTENT.length));
  docsRoutes.add(route);
  docsRouteFile.set(route, f);
}
if (allSet.has('docs-site/.gitignore')) {
  for (const line of readFileSync('docs-site/.gitignore', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^src\/content\/docs\/(.+)\.md$/);
    if (m) docsRoutes.add(docsRouteOf(m[1] + '.md'));
  }
}
const docsRouteExists = (route) => docsRoutes.has(route) || route.startsWith(OPENAPI_ROUTE_PREFIX);

// Heading slugs for the anchor check. GitHub drops punctuation, lowercases,
// and turns each space into a dash — `## Authentication & Scoping` becomes
// `#authentication--scoping`, the dropped ampersand leaving two dashes — and
// Starlight renders the same slugs. Fences are skipped so headings inside
// examples do not count.
function headingSlugs(text) {
  const slugs = new Set();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const slug = m[1].replace(/[*_`]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    if (slug) slugs.add(slug);
  }
  return slugs;
}

// Returns an error string for a reference that cannot resolve, or null.
function checkReference(raw, image, file, text) {
  const hashAt = raw.indexOf('#');
  const pathPart = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const frag = hashAt === -1 ? null : raw.slice(hashAt + 1);

  // A pure fragment is an anchor within this page.
  if (!pathPart) {
    if (!frag) return null;
    return headingSlugs(text).has(frag) ? null : `${raw} (anchor, in ${file})`;
  }

  if (file.startsWith(DOCS_CONTENT) && !image) {
    // Site surface: root-relative is a site route, anything else resolves
    // against the page's route directory.
    const base = docsRouteOf(file.slice(DOCS_CONTENT.length)).replace(/^\//, '').replace(/\/$/, '');
    let route;
    try {
      route = pathPart.startsWith('/')
        ? pathPart
        : '/' + path.posix.normalize(path.posix.join(base, decodeURIComponent(pathPart)));
    } catch { return null; } // malformed escape — leave to a parser
    route = route.replace(/\/+$/, '') || '/';
    if (route !== '/') route += '/';
    if (!docsRouteExists(route)) return `${raw} (docs-site route, in ${file})`;
    if (frag) {
      const targetFile = docsRouteFile.get(route);
      // Generated routes have no committed file here; their fragments belong
      // to the source page sync-reference.mjs copies from.
      if (targetFile && !headingSlugs(readFileSync(targetFile, 'utf8')).has(frag)) {
        return `${raw} (anchor, in ${file})`;
      }
    }
    return null;
  }

  // Repo surface (and images, which resolve against the file on both
  // surfaces). A leading `/` resolves at the repo root, where GitHub sends it.
  const rootRel = pathPart.startsWith('/');
  const target = rootRel ? pathPart.slice(1) : pathPart;
  if (!targetExists(target, rootRel ? '' : file)) {
    return `${raw} (relative, in ${file})`;
  }
  if (frag) {
    let resolved = null;
    if (rootRel) {
      resolved = allSet.has(target) ? target : allLower.get(target.toLowerCase()) ?? null;
    } else {
      try {
        const r = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target)));
        resolved = allSet.has(r) ? r : allLower.get(r.toLowerCase()) ?? null;
      } catch { resolved = null; }
    }
    if (resolved && /\.(md|mdx)$/.test(resolved) && !headingSlugs(readFileSync(resolved, 'utf8')).has(frag)) {
      return `${raw} (anchor, in ${file})`;
    }
  }
  return null;
}

const errors = [];
const warnings = [];
let checked = 0;
let allContent = '';

for (const file of mdFiles) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { warnings.push(`cannot read ${file}`); continue; }
  allContent += text + '\n';

  for (const url of extractUrls(text)) {
    checked++;
    const res = await probe(url);
    const allowed = ALLOW_NORM.has(normUrl(url));
    if ((res.status === 404 || res.status === 410) && !allowed) {
      errors.push(`${url} (in ${file})`);
    } else if (res.network || (res.status >= 400 && !allowed)) {
      warnings.push(`${url} — ${res.network ? `network: ${res.error}` : `HTTP ${res.status}`} (in ${file})`);
    }
  }

  for (const { target, image } of extractRelativeTargets(text)) {
    checked++;
    const problem = checkReference(target, image, file, text);
    if (problem) errors.push(problem);
  }
}

// Allowlist must justify itself: an entry that matches nothing is stale.
for (const [url] of ALLOW) {
  if (!allContent.includes(url)) {
    errors.push(`stale allowlist entry ${url} no longer appears in any scanned file — remove it (${ALLOW.get(url)})`);
  }
}

// ---- built-dist crawl (Tier 2, opt-in via --dist) ---------------------------
// The tracked-file pass above verifies sources; this pass verifies the OUTPUT
// that actually ships. `--dist <dir>` (pass it after the "Build docs site" CI
// job) crawls a built docs-site dist/: every href/src in every .html must
// resolve to a file inside the dist (or to a _redirects source), and every
// #fragment must match an id or a GitHub-style heading slug on the target
// page. Without --dist none of this runs, so the default gate is untouched.
const argvDist = process.argv.slice(2);
const distFlagAt = argvDist.indexOf('--dist');
if (distFlagAt !== -1 && !argvDist[distFlagAt + 1]) {
  console.error('usage: check-links.mjs [--dist <built-dist-dir>]');
  process.exit(2);
}
const distArg = distFlagAt === -1 ? undefined : argvDist[distFlagAt + 1];
if (distArg) {
  const MAX_DIST_FILES = 5000;      // crawl bound: a runaway walk is a bug
  const MAX_HTML_BYTES = 512 * 1024; // per-file bound for the attribute scan
  const distRoot = path.resolve(distArg);
  const distFiles = new Set(); // dist-relative posix paths of every file
  let distEntries = 0;
  try {
    const walkDist = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walkDist(path.join(dir, e.name));
        else {
          if (++distEntries > MAX_DIST_FILES) {
            throw new Error(`dist walk exceeded ${MAX_DIST_FILES} entries — refusing to crawl further`);
          }
          distFiles.add(path.relative(distRoot, path.join(dir, e.name)).split(path.sep).join('/'));
        }
      }
    };
    walkDist(distRoot);
  } catch (e) {
    errors.push(`dist crawl failed (${distRoot}): ${e.message}`);
  }

  // _redirects (emitted by finalize-dist.mjs): a link to a redirect SOURCE is
  // served by its destination, so sources count as resolving targets.
  const redirectSources = new Set();
  for (const rel of distFiles) {
    if (!rel.endsWith('_redirects')) continue;
    for (const line of readFileSync(path.join(distRoot, rel), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const src = t.split(/\s+/)[0];
      if (src.startsWith('/')) redirectSources.add(src);
    }
  }

  // Anchor universe of a built page: every id/name token plus GitHub-style
  // slugs of h1–h6 text — the same slug rules the source-level check applies
  // (headingSlugs above), because Starlight renders those slugs as ids but a
  // hand-written page may not.
  const distIdsCache = new Map();
  const distIdsOf = (rel) => {
    if (!distIdsCache.has(rel)) {
      const ids = new Set();
      const html = readFileSync(path.join(distRoot, rel), 'utf8');
      for (const m of html.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
      for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
        const slug = m[2].replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim()
          .toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
        if (slug) ids.add(slug);
      }
      distIdsCache.set(rel, ids);
    }
    return distIdsCache.get(rel);
  };

  for (const htmlRel of distFiles) {
    if (!htmlRel.endsWith('.html')) continue;
    const abs = path.join(distRoot, htmlRel);
    let html;
    try { html = readFileSync(abs, 'utf8'); } catch { warnings.push(`cannot read dist file ${htmlRel}`); continue; }
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) { warnings.push(`dist file over ${MAX_HTML_BYTES} bytes, attribute scan skipped: ${htmlRel}`); continue; }
    // URL directory this page's relative links resolve against: Astro emits
    // clean routes as <dir>/index.html, whose URL is <dir>/.
    const pageDir = htmlRel === 'index.html' ? ''
      : htmlRel.endsWith('/index.html') ? htmlRel.slice(0, -'index.html'.length)
      : htmlRel.replace(/[^/]*$/, '');
    for (const m of html.matchAll(/\s(href|src)\s*=\s*["']([^"']+)["']/g)) {
      const raw = m[2];
      // Skipped classes stay uncounted, matching the tracked-file pass —
      // except a pure #anchor, which is checked as an in-page anchor below.
      if (!raw || isExternal(raw)) continue;
      checked++;
      const line = html.slice(0, m.index).split('\n').length;
      const hashAt = raw.indexOf('#');
      const pathPart = hashAt === -1 ? raw : raw.slice(0, hashAt);
      const frag = hashAt === -1 ? null : raw.slice(hashAt + 1);
      if (!pathPart) {
        if (frag && !distIdsOf(htmlRel).has(frag)) errors.push(`${raw} (dist anchor, in ${htmlRel}#L${line})`);
        continue;
      }
      // Resolve in URL space. Root-relative targets live at the dist root;
      // page-relative targets resolve against this page's URL directory.
      // Percent-decoding is normalization only: raw and decoded are both
      // tried, so an encoded path cannot fail on its own encoding.
      const rawPath = pathPart.split('?')[0];
      let decPath = rawPath;
      try { decPath = decodeURIComponent(rawPath); } catch { /* malformed escape: raw still tried */ }
      let hit = null;
      for (const p of decPath === rawPath ? [rawPath] : [decPath, rawPath]) {
        if (redirectSources.has(p) || redirectSources.has(p.replace(/\/+$/, '') + '/')) { hit = 'redirect'; break; }
        const joined = p.startsWith('/')
          ? p.slice(1)
          : path.posix.normalize(path.posix.join(pageDir, p));
        const rel2 = joined.replace(/\/+$/, '');
        if (distFiles.has(rel2)) { hit = rel2; break; }
        if (distFiles.has(rel2 + '/index.html')) { hit = rel2 + '/index.html'; break; }
      }
      if (hit === 'redirect') continue;
      if (!hit) { errors.push(`${raw} (dist href, in ${htmlRel}#L${line})`); continue; }
      if (frag && hit.endsWith('.html') && !distIdsOf(hit).has(frag)) {
        errors.push(`${raw} (dist anchor, in ${htmlRel}#L${line})`);
      }
    }
  }
}
for (const e of errors) console.log(`ERROR  ${e}`);
for (const w of warnings) console.log(`warn   ${w}`);
console.log(`checked ${checked} references — ${errors.length} broken, ${warnings.length} warnings`);
process.exit(errors.length === 0 ? 0 : 1);
