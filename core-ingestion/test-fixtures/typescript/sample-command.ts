// Frozen fixture for the TypeScript parse snapshot.
//
// This replaces a snapshot of ix-cli/src/cli/commands/doctor.ts — a live source
// file under active development, so every unrelated edit to it broke the
// snapshot (#557). The point of the test is parser coverage over realistic
// TypeScript, which does not require the file to be one anybody ships.
//
// Constructs deliberately present: imports, an exported interface, a type
// alias, a union, an exported async function, a class with a constructor and
// methods, generics, and a default-exported arrow function.
import { readFileSync } from "node:fs";
import path from "node:path";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export type CheckStatus = "pass" | "warn" | "fail";

type Loader<T> = (source: string) => T;

export async function runChecks(root: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const name of ["config", "graph", "schema"]) {
    results.push(await runOne(root, name));
  }
  return results;
}

async function runOne(root: string, name: string): Promise<CheckResult> {
  const target = path.join(root, `${name}.json`);
  try {
    const raw = readFileSync(target, "utf8");
    return { name, ok: raw.length > 0 };
  } catch (err: unknown) {
    return { name, ok: false, detail: String(err) };
  }
}

export function statusOf(results: CheckResult[]): CheckStatus {
  if (results.every((r) => r.ok)) return "pass";
  if (results.some((r) => r.ok)) return "warn";
  return "fail";
}

export class CheckRunner<T> {
  private readonly loader: Loader<T>;

  constructor(loader: Loader<T>) {
    this.loader = loader;
  }

  load(source: string): T {
    return this.loader(source);
  }

  describe(results: CheckResult[]): string {
    return `${statusOf(results)}: ${results.length} checks`;
  }
}

export default (root: string) => runChecks(root);
