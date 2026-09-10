// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verify that all content-producing resolver commands support
 * --pick, --kind, and --path for consistent ambiguity resolution.
 */

const CONTENT_COMMANDS = ["read", "overview", "locate", "diff", "history"];

const commandFiles = CONTENT_COMMANDS.map(cmd => {
  const tsPath = path.resolve(__dirname, `../commands/${cmd}.ts`);
  return { cmd, tsPath, content: fs.readFileSync(tsPath, "utf-8") };
});

describe("resolver flag consistency across content commands", () => {
  for (const { cmd, content } of commandFiles) {
    describe(cmd, () => {
      it("supports --pick", () => {
        expect(content).toContain('"--pick <n>"');
      });

      it("supports --kind", () => {
        expect(content).toContain('"--kind <kind>"');
      });

      it("supports --path", () => {
        expect(content).toContain('"--path <path>"');
      });

      it("passes pick as number to resolver", () => {
        expect(content).toContain("parsePickOption");
        expect(content).toContain("pick: opts.pick");
      });
    });
  }
});
