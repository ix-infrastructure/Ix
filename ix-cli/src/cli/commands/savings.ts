import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

interface CommandBreakdown {
  count: number;
  saved: number;
}

interface SavingsData {
  commandCount: number;
  tokensSaved: number;
  naiveTokens: number;
  actualTokens: number;
  byCommandType: Record<string, CommandBreakdown>;
}

interface SavingsResponse {
  session: SavingsData;
  lifetime: SavingsData;
}

// Pricing models: input $/MTok, output $/MTok
const PRICING: Record<string, { input: number; output: number; label: string }> = {
  opus:   { input: 15,   output: 75,   label: "Claude Opus ($15/MTok in, $75/MTok out)" },
  sonnet: { input: 3,    output: 15,   label: "Claude Sonnet ($3/MTok in, $15/MTok out)" },
  haiku:  { input: 0.8,  output: 4,    label: "Claude Haiku ($0.80/MTok in, $4/MTok out)" },
  "gpt-4o": { input: 2.5, output: 10,  label: "GPT-4o ($2.50/MTok in, $10/MTok out)" },
};

const WATER_ML_PER_1K_TOKENS = 2;

function estimateMoney(tokens: number, model: string): number {
  const pricing = PRICING[model] ?? PRICING.opus;
  // Assume ~70% input, ~30% output as a rough split
  const inputTokens = tokens * 0.7;
  const outputTokens = tokens * 0.3;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function estimateWater(tokens: number): number {
  return (tokens / 1000) * WATER_ML_PER_1K_TOKENS;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}K`;
  return `~${n}`;
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatWater(ml: number): string {
  if (ml >= 1000) return `${(ml / 1000).toFixed(2)} liters`;
  return `${ml.toFixed(1)} mL`;
}

function renderBlock(label: string, data: SavingsData, model: string): void {
  const money = estimateMoney(data.tokensSaved, model);
  const water = estimateWater(data.tokensSaved);
  const avgPerQuery = data.commandCount > 0
    ? Math.ceil(data.actualTokens / data.commandCount)
    : 1;
  const extendedQueries = avgPerQuery > 0
    ? Math.floor(data.tokensSaved / avgPerQuery)
    : 0;

  console.log(chalk.bold(`  ${label}`));
  console.log(`    ${chalk.dim("Commands run".padEnd(20))}${data.commandCount}`);
  console.log(`    ${chalk.dim("Tokens saved".padEnd(20))}${formatTokens(data.tokensSaved)}`);
  console.log(`    ${chalk.dim("Money saved".padEnd(20))}${chalk.green(formatMoney(money))}`);
  console.log(`    ${chalk.dim("Water saved".padEnd(20))}${chalk.cyan(formatWater(water))}`);
  console.log(`    ${chalk.dim("Extended usage".padEnd(20))}+${extendedQueries} queries`);
}

function renderBreakdown(label: string, byCommandType: Record<string, CommandBreakdown>): void {
  const entries = Object.entries(byCommandType).sort((a, b) => b[1].saved - a[1].saved);
  if (entries.length === 0) return;

  console.log();
  console.log(chalk.bold(`  Breakdown (${label})`));
  console.log(`  ${"─".repeat(40)}`);
  for (const [cmd, data] of entries) {
    const calls = `${data.count} call${data.count === 1 ? "" : "s"}`;
    console.log(`    ${chalk.cyan(cmd.padEnd(16))}${calls.padEnd(14)}${formatTokens(data.saved)} tokens saved`);
  }
}

export function registerSavingsCommand(program: Command): void {
  const cmd = program
    .command("savings")
    .description("Show token savings from Ix usage")
    .option("--detail", "Include per-command breakdown")
    .option("--model <model>", "Pricing model (opus|sonnet|haiku|gpt-4o)", "opus")
    .option("--format <fmt>", "Output format (text|json)", "text");

  cmd.action(async (opts: { detail?: boolean; model: string; format: string }) => {
    const client = new IxClient(getEndpoint());
    const detail = opts.detail ?? false;
    const result: SavingsResponse = await client.savings(detail);

    if (opts.format === "json") {
      const pricing = PRICING[opts.model] ?? PRICING.opus;
      console.log(JSON.stringify({
        ...result,
        computed: {
          session: {
            moneySaved: estimateMoney(result.session.tokensSaved, opts.model),
            waterSavedMl: estimateWater(result.session.tokensSaved),
          },
          lifetime: {
            moneySaved: estimateMoney(result.lifetime.tokensSaved, opts.model),
            waterSavedMl: estimateWater(result.lifetime.tokensSaved),
          },
          pricingModel: pricing.label,
          waterRateMlPer1kTokens: WATER_ML_PER_1K_TOKENS,
        },
      }, null, 2));
      return;
    }

    const pricing = PRICING[opts.model] ?? PRICING.opus;

    console.log(chalk.bold("\nIx Savings"));
    console.log("─".repeat(42));
    console.log();

    renderBlock("This session", result.session, opts.model);
    console.log();
    renderBlock("All time", result.lifetime, opts.model);

    if (detail) {
      if (Object.keys(result.session.byCommandType).length > 0) {
        renderBreakdown("this session", result.session.byCommandType);
      }
      if (Object.keys(result.lifetime.byCommandType).length > 0) {
        renderBreakdown("all time", result.lifetime.byCommandType);
      }
    }

    console.log();
    console.log(chalk.dim(`  Model: ${pricing.label}`));
    console.log(chalk.dim(`  Water rate: ${WATER_ML_PER_1K_TOKENS}mL / 1K tokens`));
    console.log();
  });

  cmd.command("reset")
    .description("Reset lifetime savings totals")
    .action(async () => {
      const client = new IxClient(getEndpoint());
      await client.savingsReset();
      console.log(chalk.green("  Savings data reset."));
    });
}
