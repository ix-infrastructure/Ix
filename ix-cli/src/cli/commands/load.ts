/**
 * `ix load <url|path>` — Multi-source semantic ingestion command.
 *
 * Thin client: detects source type, fetches content, and POSTs to the
 * backend's /v1/load endpoint which handles LLM extraction, embedding,
 * and patch commit server-side.
 *
 * Supports: tweets, arXiv papers, PDFs, images/screenshots, webpages,
 * chat exports, and generic local files.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { detectSource } from "../sources/detect.js";
import { fetchContent } from "../sources/fetch.js";

interface LoadOptions {
  format: string;
  verbose: boolean;
}

export function registerLoadCommand(program: Command): void {
  program
    .command("load")
    .description("Ingest a URL or file into the knowledge graph (papers, tweets, screenshots, etc.)")
    .argument("<source>", "URL or local file path to ingest")
    .option("--format <format>", "Output format (text or json)", "text")
    .option("--verbose", "Show detailed output", false)
    .action(async (source: string, opts: LoadOptions) => {
      try {
        await runLoad(source, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.format === "json") {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(`Error: ${msg}`));
        }
        process.exitCode = 1;
      }
    });
}

async function runLoad(source: string, opts: LoadOptions): Promise<void> {
  const isJson = opts.format === "json";

  // 1. Detect source type
  const detected = detectSource(source);

  if (detected.kind === "github") {
    if (!isJson) {
      console.error(
        chalk.yellow("GitHub repos should be ingested with: ix ingest --github <owner/repo>")
      );
    }
    process.exitCode = 1;
    return;
  }

  if (!isJson) {
    console.log(
      chalk.dim(`Detected source type: `) + chalk.cyan(detected.kind) +
      chalk.dim(` (${detected.uri})`)
    );
  }

  // 2. Fetch content
  if (!isJson) process.stdout.write(chalk.dim("Fetching content... "));
  const content = await fetchContent(detected);
  if (!isJson) {
    const size = content.text
      ? `${content.text.length} chars`
      : content.binary
        ? `${(content.binary.length / 1024).toFixed(1)} KB`
        : "empty";
    console.log(chalk.green(`done`) + chalk.dim(` (${size})`));
  }

  // 3. Build request payload for backend
  const payload: Record<string, unknown> = {
    uri: detected.uri,
    kind: detected.kind,
    meta: { ...detected.meta, ...content.meta },
  };

  if (content.text) {
    payload.text = content.text;
  }

  if (content.binary) {
    payload.binaryBase64 = content.binary.toString("base64");
    payload.contentType = (content.meta.content_type as string) ?? undefined;
  }

  // 4. POST to backend — extraction, embedding, and commit happen server-side
  if (!isJson) process.stdout.write(chalk.dim("Extracting and committing... "));

  const endpoint = getEndpoint();
  const resp = await fetch(`${endpoint}/v1/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5 * 60 * 1000), // 5 min for LLM extraction
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Backend error (${resp.status}): ${text}`);
  }

  const result = (await resp.json()) as {
    status: string;
    rev: number;
    patchId: string;
    nodes: number;
    edges: number;
    claims: number;
  };

  if (!isJson) {
    console.log(chalk.green("done") + chalk.dim(` (rev ${result.rev})`));
    console.log();
    console.log(
      chalk.bold("Ingested: ") +
      chalk.cyan(detected.kind) +
      chalk.dim(" → ") +
      `${result.nodes} nodes, ${result.edges} edges, ${result.claims} claims` +
      chalk.dim(` (rev ${result.rev})`)
    );
  } else {
    console.log(JSON.stringify({
      status: result.status,
      kind: detected.kind,
      uri: detected.uri,
      nodes: result.nodes,
      edges: result.edges,
      claims: result.claims,
      rev: result.rev,
      patchId: result.patchId,
    }));
  }
}
