import * as fs from "node:fs";

/** Read file content safely, returning null if inaccessible. */
export function readFileContent(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
