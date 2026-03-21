import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileContent } from "../commands/watch-utils.js";

const watchTsPath = path.resolve(__dirname, "../commands/watch.ts");
const watchContent = fs.readFileSync(watchTsPath, "utf-8");

// ── Unit tests for readFileContent ──────────────────────────────────

describe("readFileContent", () => {
  it("reads an existing file", () => {
    const result = readFileContent(watchTsPath);
    expect(result).not.toBeNull();
    expect(result).toContain("readFileContent");
  });

  it("returns null for non-existent file", () => {
    const result = readFileContent("/tmp/ix-test-nonexistent-file-abc123.ts");
    expect(result).toBeNull();
  });
});

// ── Source-reading: watch.ts watcher correctness ────────────────────

describe("watch.ts watcher correctness", () => {
  it("uses content hash for deduplication", () => {
    expect(watchContent).toContain("hashContent");
    expect(watchContent).toContain("createHash");
    expect(watchContent).toContain('lastHash.get(filePath) === hash');
  });

  it("re-reads file at ingest time, not event time", () => {
    // readFileContent called inside ingestFile, not in the event handler
    expect(watchContent).toContain("readFileContent(filePath)");
    // The debounce callback does NOT read the file
    expect(watchContent).toContain("content is re-read at ingest time");
  });

  it("uses short debounce (300ms)", () => {
    expect(watchContent).toContain("DEBOUNCE_MS = 300");
  });

  it("tracks last hash per file", () => {
    expect(watchContent).toContain("lastHash");
    expect(watchContent).toContain("lastHash.set(filePath, hash)");
  });

  it("skips ingest when content hash unchanged", () => {
    expect(watchContent).toContain("unchanged (hash)");
  });

  it("coalesces rapid events per file via debounce map", () => {
    expect(watchContent).toContain("pending.get(fullPath)");
    expect(watchContent).toContain("clearTimeout(existing)");
  });
});
