#!/usr/bin/env node
/**
 * API-reference parity gate for docs/api.
 *
 * docs/api/README.md claims the reference is generated from the client source.
 * This check makes that claim machine-enforced across four surfaces, each
 * failing with the item named:
 *
 *   1. Endpoints — every path+method the client calls (ix-cli/src/client/api.ts)
 *      must be in docs/api/openapi.yaml, and every documented endpoint must be
 *      called by the client. The visualizer proxy (view.ts) forwards every
 *      /v1/* request and defines no endpoints, so the client is the complete
 *      source of truth.
 *   2. YAML validity + $ref integrity — openapi.yaml is parsed with the `yaml`
 *      package; a malformed document, or a $ref targeting a missing schema,
 *      fails here.
 *   3. Schema contract — every schema in components/schemas must exist as an
 *      exported type in ix-cli/src/client/types.ts. Schemas that are genuine
 *      backend response shapes with no client type are allowed only via the
 *      explicit BACKEND_ONLY_SCHEMAS allowlist.
 *   4. README sections — the "Endpoints by Area" section (#### METHOD
 *      `path` headings and | METHOD | `path` | table rows) must match the
 *      OpenAPI paths in both directions, so the human-readable mirror cannot
 *      drift from the machine reference.
 *
 * The client-side parser fails LOUD instead of silently passing: an
 * unclassified call verb (this.request(...)), a known verb whose path is not
 * a literal /v1 string (this.get(PATHS.x)), or a fetch with a literal
 * non-/v1 path after ${this.endpoint} is reported, so a new call pattern
 * cannot quietly escape the gate.
 *
 * Paths are normalized on both sides before comparing: query strings are
 * dropped and `{name}` / `${name}` parameter slots are collapsed to `{p}`, so
 * `/v1/entity/${id}` matches the reference's `/v1/entity/{id}` regardless of
 * the parameter name.
 *
 *   node scripts/check-api-parity.mjs            # default paths, from ix-cli/
 *   node scripts/check-api-parity.mjs --api P    # explicit api.ts path
 *   node scripts/check-api-parity.mjs --doc P    # explicit openapi.yaml path
 *   node scripts/check-api-parity.mjs --types P  # explicit types.ts path
 *   node scripts/check-api-parity.mjs --readme P # explicit api README path
 *
 * Exit 0 = parity; 1 = gaps listed on stdout.
 */
import { parse } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const apiDefault = join(here, "..", "src", "client", "api.ts");
const typesDefault = join(here, "..", "src", "client", "types.ts");
const docDefault = join(repoRoot, "docs", "api", "openapi.yaml");
const readmeDefault = join(repoRoot, "docs", "api", "README.md");

const argValue = (name, fallback) => {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    process.stderr.write(`error: option '${name} <value>' argument missing\n`);
    process.exit(1);
  }
  return v;
};
const apiPath = argValue("--api", apiDefault);
const typesPath = argValue("--types", typesDefault);
const docPath = argValue("--doc", docDefault);
const readmePath = argValue("--readme", readmeDefault);

for (const [label, p] of [
  ["api.ts", apiPath],
  ["types.ts", typesPath],
  ["openapi.yaml", docPath],
  ["README.md", readmePath],
]) {
  if (!existsSync(p)) {
    process.stderr.write(`check-api-parity: ${label} not found at ${p}\n`);
    process.exit(1);
  }
}

// Schemas that are genuine backend response shapes with no counterpart in the
// client's shared types (the responses are documented in README prose/table
// form). Deliberately tiny; anything else must exist in types.ts.
const BACKEND_ONLY_SCHEMAS = new Set(["ResetResult", "NodeCreationResult"]);

const VERBS = new Set(["get", "post", "put", "delete", "patch"]);
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

const errors = [];

// Normalize a raw path token to a comparable key. A `${...}` slot is a real
// path parameter only when it sits directly after a `/` (`/v1/entity/${id}`);
// interpolations appended to a segment name (`/v1/patches${qs ? ...}`) build
// query text and the token is cut at the slot. `{name}` braces (the doc side)
// and real parameter slots collapse to `{p}`, and any remaining `?...` query
// is dropped.
const normalize = (raw) =>
  raw
    .replace(/(?<!\/)\$\{[^}]*.*$/, "") // query-builder interpolation: cut the token
    .replace(/(\/)\$\{[^}]*\}/g, "$1{p}") // real path parameter: collapse to {p}
    .replace(/\{[^}]*\}/g, "{p}") // doc-side braces: collapse to {p}
    .split("?")[0];

// --- 2. Documented surface: parse openapi.yaml (validity gate) ---------------
let doc;
try {
  doc = parse(readFileSync(docPath, "utf8"));
} catch (err) {
  console.log(`check-api-parity: ${docPath} does not parse as YAML: ${err.message}`);
  process.exit(1);
}

const documented = new Set();
for (const [path, methods] of Object.entries(doc.paths ?? {})) {
  const norm = normalize(path);
  for (const method of Object.keys(methods ?? {})) {
    if (HTTP_VERBS.has(method.toLowerCase())) {
      documented.add(`${method.toUpperCase()} ${norm}`);
    }
  }
}

// $ref integrity: every $ref must target an existing schema.
const refs = new Set();
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") refs.add(node.$ref);
    for (const v of Object.values(node)) walk(v);
  }
})(doc);
const schemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));
for (const ref of refs) {
  if (!ref.startsWith("#/components/schemas/")) {
    errors.push(`openapi non-local $ref: ${ref}`);
    continue;
  }
  const name = ref.slice("#/components/schemas/".length);
  if (!schemaNames.has(name)) errors.push(`openapi $ref targets missing schema: ${ref}`);
}

// --- 3. Schema contract: every schema must exist in types.ts -----------------
const typeNames = new Set(
  [...readFileSync(typesPath, "utf8").matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)].map(
    (m) => m[1],
  ),
);
for (const name of schemaNames) {
  if (!typeNames.has(name) && !BACKEND_ONLY_SCHEMAS.has(name)) {
    errors.push(`schema ${name} has no types.ts counterpart — add the type, or allowlist it as backend-only`);
  }
}

// --- 4. README "Endpoints by Area" must match the OpenAPI paths ---------------
const readmeSrc = readFileSync(readmePath, "utf8");
const areaStart = readmeSrc.indexOf("## Endpoints by Area");
const areaEnd = readmeSrc.indexOf("## Visualizer Proxy Surface");
if (areaStart < 0 || areaEnd < 0 || areaEnd <= areaStart) {
  errors.push(`README: cannot locate the Endpoints by Area span`);
} else {
  const span = readmeSrc.slice(areaStart, areaEnd);
  const readmeEndpoints = new Set();
  for (const m of span.matchAll(/^#### (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) `([^`]+)`/gm)) {
    readmeEndpoints.add(`${m[1]} ${normalize(m[2])}`);
  }
  for (const m of span.matchAll(/^\| (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \| `([^`]+)`/gm)) {
    readmeEndpoints.add(`${m[1]} ${normalize(m[2])}`);
  }
  for (const key of [...readmeEndpoints].sort()) {
    if (!documented.has(key)) errors.push(`README lists endpoint missing from openapi.yaml: ${key}`);
  }
  for (const key of [...documented].sort()) {
    if (!readmeEndpoints.has(key)) {
      errors.push(`openapi endpoint missing from README Endpoints by Area: ${key}`);
    }
  }
}

// --- 1. Client surface: every call in api.ts, failing loud on new patterns ----
const calls = new Set();
const add = (method, raw) => calls.add(`${method} ${normalize(raw)}`);
const apiSrc = readFileSync(apiPath, "utf8");
const apiLines = apiSrc.split(/\r?\n/);

// Unclassified call verb: this.<anything>(...) carrying a literal /v1 path
// (as first arg or later) is a call pattern this gate does not know how to
// classify — report it so the surface cannot grow a silent hole. Known
// helpers whose string args are captured by their own pass (runReset) are
// excluded.
const KNOWN_HELPERS = new Set(["runReset"]);
for (let i = 0; i < apiLines.length; i++) {
  const call = apiLines[i].match(/this\.([a-zA-Z_$][\w$]*)(?:<.*?>)?\(/);
  if (!call) continue;
  const verb = call[1];
  if (VERBS.has(verb) || KNOWN_HELPERS.has(verb)) continue;
  let lit = apiLines[i].match(/\/v1[^\s"'`]*/);
  for (let k = 1; !lit && i + k < apiLines.length && k <= 2; k++) {
    lit = apiLines[i + k].match(/\/v1[^\s"'`]*/);
  }
  if (lit) {
    errors.push(`unclassified client call verb: this.${verb}(...) near line ${i + 1} — extend check-api-parity`);
  }
}

// Known verbs: the path argument is always a literal on the call line or the
// next two (ternary forms like `this.post(qs ? \`/v1/smells?${qs}\` : "/v1/smells", {})`
// yield two tokens that normalize to the same key). A call with no literal
// path at all is a new, unparseable pattern — fail loud instead of passing.
for (let i = 0; i < apiLines.length; i++) {
  const call = apiLines[i].match(/this\.(get|post|put|delete|patch)(?:<.*?>)?\(/);
  if (!call) continue;
  const method = call[1].toUpperCase();
  let tokens = [...apiLines[i].matchAll(/\/v1[^\s"'`]*/g)].map((t) => t[0]);
  for (let k = 1; tokens.length === 0 && i + k < apiLines.length && k <= 2; k++) {
    tokens = [...apiLines[i + k].matchAll(/\/v1[^\s"'`]*/g)].map((t) => t[0]);
  }
  if (tokens.length === 0) {
    errors.push(`unparsed client call: this.${call[1]}( on line ${i + 1} — path is not a literal /v1 string`);
    continue;
  }
  for (const token of tokens) add(method, token);
}

// Direct `fetch(\`${this.endpoint}/v1/...\`, { method: "POST", ... })` calls —
// the method option may sit on the line after the fetch (ingest, patch, map,
// patches/bulk), or on the same line (reset/status, savings DELETE). Look a
// bounded window ahead for it; default GET. A literal path that is not /v1 is
// a new surface — fail loud. A template with no literal path at all
// (${this.endpoint}${syncPath}) is helper-routed and covered by the runReset
// pass below.
for (let i = 0; i < apiLines.length; i++) {
  const fetch = apiLines[i].match(/fetch\(\s*[`'"]\$\{this\.endpoint\}([^`'"]*)[`'"]/);
  if (!fetch) continue;
  const tail = fetch[1];
  if (/^\$\{/.test(tail)) continue; // helper-routed (runReset), no literal path
  if (!tail.startsWith("/v1")) {
    errors.push(`unparsed fetch path at line ${i + 1}: ${tail} — literal path must start with /v1`);
    continue;
  }
  let method = "GET";
  for (let j = i; j < Math.min(i + 5, apiLines.length); j++) {
    const m = apiLines[j].match(/method:\s*["'](\w+)["']/);
    if (m) {
      method = m[1].toUpperCase();
      break;
    }
  }
  add(method, tail);
}

// `runReset(asyncPath, syncPath, ...)` posts to both paths; the sync leg goes
// through a `fetch(\`${this.endpoint}${syncPath}\`)` whose path is a variable,
// so the two literal arguments here are the only statically visible form.
for (const m of apiSrc.matchAll(/this\.runReset\(\s*"([^"]+)",\s*"([^"]+)"/g)) {
  add("POST", m[1]);
  add("POST", m[2]);
}

// --- Compare the endpoint surface in both directions --------------------------
for (const key of [...calls].sort()) {
  if (!documented.has(key)) errors.push(`undocumented endpoint: ${key}`);
}
for (const key of [...documented].sort()) {
  if (!calls.has(key)) errors.push(`stale doc entry: ${key}`);
}

if (errors.length === 0) {
  console.log(
    `check-api-parity: ${documented.size} documented, ${calls.size} called, ` +
      `${schemaNames.size} schemas, ${refs.size} refs — parity with docs/api`,
  );
  process.exit(0);
}

for (const e of errors) console.log(e);
console.log(`check-api-parity: ${errors.length} gap(s) — fix the docs or extend the gate`);
process.exit(1);
