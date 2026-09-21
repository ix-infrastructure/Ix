// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  BUNDLE_CHARS_PER_TOKEN,
  clampBudgets,
  detectContextModeConflict,
  registerContextCommand,
} from "../commands/context.js";

describe("--max-tokens", () => {
  it("is what bounds a default bundle, not 12,000 characters", () => {
    const budgets = clampBudgets({});
    expect(budgets.maxTokens).toBe(1500);
    expect(budgets.maxChars).toBe(Math.round(1500 * BUNDLE_CHARS_PER_TOKEN));
    // The old default was nearly four times this.
    expect(budgets.maxChars).toBeLessThan(12_000);
  });

  it("moves the character budget with it", () => {
    expect(clampBudgets({ maxTokens: 3000 }).maxChars).toBe(Math.round(3000 * BUNDLE_CHARS_PER_TOKEN));
    expect(clampBudgets({ maxTokens: 500 }).maxChars).toBe(1070);
  });

  it("is clamped to its range before it is converted", () => {
    expect(clampBudgets({ maxTokens: 1 }).maxTokens).toBe(500);
    expect(clampBudgets({ maxTokens: 10_000_000 }).maxTokens).toBe(200_000);
    // And the derived character budget still lands inside --max-chars' range.
    expect(clampBudgets({ maxTokens: 10_000_000 }).maxChars).toBeLessThanOrEqual(1_000_000);
    expect(clampBudgets({ maxTokens: 1 }).maxChars).toBeGreaterThanOrEqual(1000);
  });

  it("gives way to an explicit --max-chars", () => {
    const budgets = clampBudgets({ maxChars: 40_000 });
    expect(budgets.maxChars).toBe(40_000);
    // The token field still reports what it would have been, so --diff can say
    // which budget the caller had in force.
    expect(budgets.maxTokens).toBe(1500);
  });

  it("is refused alongside --max-chars rather than silently losing to it", () => {
    const message = detectContextModeConflict({ maxTokens: 2000, maxChars: 40_000 });
    expect(message).toContain("--max-tokens and --max-chars cannot be combined");
    expect(detectContextModeConflict({ maxTokens: 2000 })).toBeUndefined();
    expect(detectContextModeConflict({ maxChars: 40_000 })).toBeUndefined();
  });

  it("is registered, and refuses a value that is not a positive integer", () => {
    const program = new Command().name("ix").exitOverride();
    registerContextCommand(program);
    const context = program.commands.find((c) => c.name() === "context")!;
    const option = context.options.find((o) => o.long === "--max-tokens");
    expect(option).toBeDefined();
    expect(() => option!.parseArg!("1e3", undefined)).toThrow(/positive integer/);
  });
});
