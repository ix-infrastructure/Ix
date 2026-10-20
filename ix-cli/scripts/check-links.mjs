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
// checked too: a #fragment must match an anchor on the target page — a
// GitHub-style heading slug (the same ones GitHub and Starlight render,
// duplicate suffixes included) or an explicit id/name attribute.
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
// Allowlist: only links known-dead with a tracked replacement. Keys are
// normalized through the same URL normalization the extractor uses, so a
// trailing-slash variant of an allowed URL cannot false-fail. An allow entry
// that no longer appears in any scanned file is itself an ERROR — a stale
// allowlist must not rot silently.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
// One owner for case-insensitive lookup, keyed lowercase, and it answers both
// questions: `.has()` for "does this exist" and `.get()` for the real spelling.
// Two structures over one key space is what produced the live crash —
// `TypeError: allLower.get is not a function` — so there is deliberately one.
const lowerToActual = new Map(allFiles.map((f) => [f.toLowerCase(), f]));

function targetExists(target, file) {
  let t = target.split('#')[0].split('?')[0];
  if (!t) return true; // pure anchor
  let resolved;
  try {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(t)));
  } catch { return true; } // malformed escape — leave to a link checker that parses
  if (allSet.has(resolved) || lowerToActual.has(resolved.toLowerCase())) return true;
  // A directory target is fine if any tracked file lives under it.
  const prefix = resolved.endsWith('/') ? resolved : resolved + '/';
  return [...lowerToActual.keys()].some((f) => f.startsWith(prefix.toLowerCase()));
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

// ---- one anchor universe ---------------------------------------------------
// Heading slugs for the anchor check. GitHub drops punctuation, lowercases,
// and turns each space into a dash — `## Authentication & Scoping` becomes
// `#authentication--scoping`, the dropped ampersand leaving two dashes — and
// Starlight renders the same slugs. Fences are skipped so headings inside
// examples do not count.
//
// Every surface goes through slugifyHeading() so the source pass and the
// built-dist pass cannot drift, and every anchor a page exposes is collected
// here: heading slugs AND explicit id/name attributes. Three things the first
// cut of this check got wrong, each one a false CI failure on a valid anchor:
//
//   * a repeated heading. GitHub suffixes duplicates per base slug, so a second
//     `## Setup` renders as `#setup-1` — and `#setup-1` is a real anchor, not a
//     typo.
//   * an explicit HTML anchor. `<a id="custom-anchor"></a>` has no heading at
//     all, so slug-matching alone could never see it.
//   * collapsing whitespace runs. Each space is its own dash, so `A & B` is
//     `a--b`, not `a-b`.
//
// stripTags is a single left-to-right scan, never a regex that deletes
// `<[^>]+>` and hopes nothing survives it. Deleting a match can CREATE the
// pattern it was matching — `<scr<script>ipt>` loses `<scr<script>` in one pass
// and leaves `<script>` behind, which is exactly the
// js/incomplete-multi-character-sanitization finding this replaced. The scan has
// no second pass to miss and no fixed point to reach: a `<` that opens a tag
// drops the whole region through the next `>`, nesting and overlap included. A
// `<` that cannot open a tag (`a < b` in prose) or that never closes is literal
// text and is kept — truncating there would silently mangle a valid slug. The
// allowlist alphabet in slugifyHeading then admits only letters, digits,
// whitespace, `-` and `_`, so no markup can reach a slug key even in principle.
function stripTags(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out += s.slice(i); break; }
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1 || !/[A-Za-z/!]/.test(s[lt + 1] ?? '')) {
      out += s.slice(i, lt + 1); // a literal `<`, not a tag opener
      i = lt + 1;
      continue;
    }
    out += s.slice(i, lt);
    i = gt + 1;
  }
  return out;
}

function slugifyHeading(raw) {
  return stripTags(raw).replace(/[*_`]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

// GitHub's per-page duplicate numbering: the slugs added are `setup`, `setup-1`,
// `setup-2`, … counting only slugs this collector minted, so an unrelated
// `id="setup"` attribute cannot demote the first `<h2>Setup</h2>` to `setup-1`.
function slugAdder(into) {
  const counts = new Map();
  const seen = new Set();
  return (base) => {
    if (!base) return;
    let n = counts.get(base) ?? 0;
    let slug = n === 0 ? base : `${base}-${n}`;
    while (seen.has(slug)) { n += 1; slug = `${base}-${n}`; }
    counts.set(base, n + 1);
    seen.add(slug);
    into.add(slug);
  };
}

// Fragment targets that are not headings. `<a id="x">` and `<h2 id="x">` are
// the obvious ones; the trap is that `\b(?:id|name)\s*=` also matches attributes
// that are not anchors at all — `<meta name="description">`, `data-id="…"`, and a
// form control's `name` — which quietly made `#description` a valid anchor on
// every built page. So the attributes are read off parsed open tags, with two
// rules:
//
//   * `id` counts on any element: in HTML, any element with an id is a fragment
//     target.
//   * `name` counts only on `<a>`. That is the legacy anchor form there, and a
//     form field's name everywhere else — precisely the class of non-target this
//     replaced.
//
// `(?<![\w-])` keeps `data-id=` and `data-name=` out: a word character or `-`
// immediately before the attribute name means it is a different attribute. `<meta>`
// and `<link>` describe the document rather than its content, so their ids are not
// anchors anyone links to, and they are skipped.
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ID_ATTR = /(?<![\w-])id\s*=\s*["']([^"']+)["']/g;
const NAME_ATTR = /(?<![\w-])name\s*=\s*["']([^"']+)["']/g;

function tagAnchors(text, into) {
  for (const m of text.matchAll(OPEN_TAG)) {
    const tag = m[1].toLowerCase();
    if (tag === 'meta' || tag === 'link') continue;
    for (const a of m[2].matchAll(ID_ATTR)) into.add(a[1]);
    if (tag === 'a') for (const a of m[2].matchAll(NAME_ATTR)) into.add(a[1]);
  }
}

function collectAnchors(text) {
  const anchors = new Set();
  const addHeading = slugAdder(anchors);
  const body = [];
  // Fenced blocks, by CommonMark's rule: a block opens with a run of three or
  // more backticks or tildes and is closed only by a run of the SAME character
  // at least as long as the opening one, with nothing after it. Flipping a
  // boolean on any delimiter instead treated a shorter run inside a longer one as
  // the end of the block — and a longer fence quoting a shorter one is how docs
  // show a fence at all — so the block state inverted and everything after it was
  // read backwards: a real heading reported as broken (the false CI failure this
  // check exists to avoid) while a heading-shaped line of code was accepted as an
  // anchor. The built page is rendered by a CommonMark parser, so the source pass
  // has to apply the same rule or the two surfaces disagree about what is code.
  let fenceChar = null; // null = not inside a fence
  let fenceLen = 0;
  for (const line of text.split(/\r?\n/)) {
    const delims = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceChar === null) {
      // A backtick fence's info string may not contain a backtick — a line like
      // ``` `x` ``` is prose, not the start of a block.
      if (delims && !(delims[1][0] === '`' && delims[2].includes('`'))) {
        fenceChar = delims[1][0];
        fenceLen = delims[1].length;
        continue;
      }
    } else if (delims && delims[1][0] === fenceChar
      && delims[1].length >= fenceLen && delims[2].trim() === '') {
      fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    body.push(line);
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) addHeading(slugifyHeading(m[1]));
  }
  // Non-fenced text only: tags inside a fenced example do not count, the same
  // rule the headings follow. Joined, so an anchor tag split across lines still
  // resolves.
  tagAnchors(body.join('\n'), anchors);
  return anchors;
}

// A page is parsed once and the result kept: a fragment check used to re-read
// and re-parse the target file for every anchor on every page.
const anchorsCache = new Map();
function anchorsOf(file) {
  if (!anchorsCache.has(file)) {
    anchorsCache.set(file, collectAnchors(readFileSync(file, 'utf8')));
  }
  return anchorsCache.get(file);
}

// Returns an error string for a reference that cannot resolve, or null.
function checkReference(raw, image, file, text) {
  const hashAt = raw.indexOf('#');
  const pathPart = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const frag = hashAt === -1 ? null : raw.slice(hashAt + 1);

  // A pure fragment is an anchor within this page.
  if (!pathPart) {
    if (!frag) return null;
    return anchorsOf(file).has(frag) ? null : `${raw} (anchor, in ${file})`;
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
      if (targetFile && !anchorsOf(targetFile).has(frag)) {
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
    // Only the decode can throw. Keeping the lookup outside the try is
    // deliberate: this used to swallow every error in the block — including a
    // `TypeError` from asking a Set for `.get()` — and the anchor check then
    // disappeared without a word.
    let rel = null;
    if (rootRel) {
      rel = target;
    } else {
      try {
        rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target)));
      } catch { rel = null; }
    }
    const resolved = rel === null
      ? null
      : (allSet.has(rel) ? rel : lowerToActual.get(rel.toLowerCase()) ?? null);
    if (resolved && /\.(md|mdx)$/.test(resolved) && !anchorsOf(resolved).has(frag)) {
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
  anchorsCache.set(file, collectAnchors(text)); // parse each page once

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

for (const e of errors) console.log(`ERROR  ${e}`);
for (const w of warnings) console.log(`warn   ${w}`);
console.log(`checked ${checked} references — ${errors.length} broken, ${warnings.length} warnings`);
process.exit(errors.length === 0 ? 0 : 1);
