// Copyright 2026 Ix Infrastructure Inc.

// Tables from eval.mjs output: mean recall @5/@10/@20 per language and
// overall, and per-instance wins/losses against a reference variant (a win is
// a higher recall at that cutoff).
//
//   node summarize.mjs results/dev-*.jsonl [--ref base] [--metric bm25|plan] [--md]
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const ref = opt("ref", "base");
const metric = opt("metric", "bm25");
const files = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const recs = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => !r.skipped && r[metric]);
const byVariant = new Map();
for (const r of recs) {
  if (!byVariant.has(r.variant)) byVariant.set(r.variant, new Map());
  byVariant.get(r.variant).set(r.id, r);
}
const langs = [...new Set(recs.map((r) => r.lang))].sort();
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f3 = (x) => x.toFixed(3);
const refMap = byVariant.get(ref);
console.log(`metric=${metric} ref=${ref} n=${refMap?.size}`);
const head = ["variant", "@5", "@10", "@20", ...langs.map((l) => `${({ JavaScript: "JS", TypeScript: "TS", Python: "Py", Java: "Java" })[l] ?? l} @5/@10/@20`), "W/L @5", "W/L @10", "W/L @20"];
console.log(head.join(" | "));
for (const [v, m] of byVariant) {
  const rs = [...m.values()];
  const cells = [v, ...[0, 1, 2].map((k) => f3(mean(rs.map((r) => r[metric][k]))))];
  for (const l of langs) {
    const lr = rs.filter((r) => r.lang === l);
    cells.push(`${[0, 1, 2].map((k) => mean(lr.map((r) => r[metric][k])).toFixed(2)).join("/")} (${lr.length})`);
  }
  for (const k of [0, 1, 2]) {
    let w = 0, l = 0;
    for (const r of rs) {
      const b = refMap?.get(r.id);
      if (!b) continue;
      if (r[metric][k] > b[metric][k] + 1e-9) w++;
      else if (r[metric][k] < b[metric][k] - 1e-9) l++;
    }
    cells.push(`${w}/${l}`);
  }
  console.log(cells.join(" | "));
}

// Micro precision keeps every returned item in the denominator; macro F@5
// stays paired on the same instances so an empty answer cannot win by silence.
if (recs.some((r) => r.contextPrecision)) {
  console.log("\ncontext precision | before returned/acted/precision/F@5 | after returned/acted/precision/F@5");
  for (const [variant, records] of byVariant) {
    const paired = [...records.values()].filter((r) => r.contextPrecision);
    const cells = [variant];
    for (const side of ["before", "after"]) {
      const values = paired.map((r) => r.contextPrecision[side]);
      const returned = values.reduce((n, v) => n + v.items_returned, 0);
      const acted = values.reduce((n, v) => n + v.items_acted_on, 0);
      const recall = values.map((v) => v.file_recall_at_5).filter((v) => v !== null);
      cells.push(`${returned}/${acted}/${returned ? f3(acted / returned) : "n/a"}/${recall.length ? f3(mean(recall)) : "n/a"}`);
    }
    console.log(cells.join(" | "));
  }
}
