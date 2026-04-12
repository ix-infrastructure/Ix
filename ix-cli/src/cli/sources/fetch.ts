/**
 * Per-source-type content fetchers.
 *
 * Each fetcher takes a DetectedSource and returns a FetchedContent object
 * containing the raw content (text or binary) plus extracted metadata.
 */

import { readFileSync } from "node:fs";
import type { DetectedSource, SourceKind } from "./detect.js";

export interface FetchedContent {
  kind: SourceKind;
  /** Source URI for provenance tracking. */
  uri: string;
  /** Text content (for text-based sources). */
  text?: string;
  /** Binary content (for images, PDFs). */
  binary?: Buffer;
  /** Structured metadata extracted during fetch. */
  meta: Record<string, unknown>;
}

type Fetcher = (source: DetectedSource) => Promise<FetchedContent>;

const fetchers: Record<string, Fetcher> = {
  tweet: fetchTweet,
  arxiv: fetchArxiv,
  pdf: fetchPdf,
  image: fetchImage,
  webpage: fetchWebpage,
  chat_export: fetchChatExport,
  local_file: fetchLocalFile,
};

export async function fetchContent(source: DetectedSource): Promise<FetchedContent> {
  const fetcher = fetchers[source.kind];
  if (!fetcher) {
    throw new Error(`No fetcher for source kind: ${source.kind}`);
  }
  return fetcher(source);
}

// ─── Tweet ──────────────────────────────────────────────────────────

async function fetchTweet(source: DetectedSource): Promise<FetchedContent> {
  // Use Twitter oEmbed API — no auth required, returns HTML + metadata
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(source.uri)}&omit_script=true`;

  const resp = await fetch(oembedUrl, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`Twitter oEmbed failed (${resp.status}): ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    html: string;
    author_name: string;
    author_url: string;
    url: string;
  };

  // Strip HTML tags to get plain text
  const plainText = decodeEntities(
    data.html.replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();

  return {
    kind: "tweet",
    uri: source.uri,
    text: plainText,
    meta: {
      author: data.author_name,
      author_url: data.author_url,
      tweet_url: data.url,
      tweet_id: source.meta.tweetId,
    },
  };
}

// ─── arXiv ──────────────────────────────────────────────────────────

async function fetchArxiv(source: DetectedSource): Promise<FetchedContent> {
  const paperId = source.meta.paperId;
  // Use arXiv abstract page for metadata extraction
  const absUrl = paperId
    ? `https://arxiv.org/abs/${paperId}`
    : source.uri.replace("/pdf/", "/abs/").replace("/html/", "/abs/");

  const resp = await fetch(absUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`arXiv fetch failed (${resp.status})`);
  }

  const html = await resp.text();

  // Extract metadata from the HTML
  const title = extractMeta(html, "citation_title") ?? extractTag(html, "title") ?? "Unknown";
  const abstract = extractMetaContent(html, "citation_abstract")
    ?? extractByClass(html, "abstract")
    ?? "";
  const authors = extractAllMeta(html, "citation_author");
  const date = extractMeta(html, "citation_date") ?? "";
  const doi = extractMeta(html, "citation_doi") ?? "";

  const text = `# ${title}\n\n**Authors:** ${authors.join(", ")}\n**Date:** ${date}\n\n## Abstract\n\n${abstract.trim()}`;

  return {
    kind: "arxiv",
    uri: source.uri,
    text,
    meta: {
      paper_id: paperId ?? "",
      title,
      authors,
      date,
      doi,
      abstract_url: absUrl,
    },
  };
}

// ─── PDF ────────────────────────────────────────────────────────────

async function fetchPdf(source: DetectedSource): Promise<FetchedContent> {
  if (isUrl(source.uri)) {
    const resp = await fetch(source.uri, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      throw new Error(`PDF download failed (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return {
      kind: "pdf",
      uri: source.uri,
      binary: buffer,
      meta: { size: buffer.length },
    };
  }

  // Local file
  const buffer = readFileSync(source.uri);
  return {
    kind: "pdf",
    uri: source.uri,
    binary: buffer,
    meta: { size: buffer.length },
  };
}

// ─── Image ──────────────────────────────────────────────────────────

async function fetchImage(source: DetectedSource): Promise<FetchedContent> {
  if (isUrl(source.uri)) {
    const resp = await fetch(source.uri, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`Image download failed (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return {
      kind: "image",
      uri: source.uri,
      binary: buffer,
      meta: { size: buffer.length, content_type: resp.headers.get("content-type") ?? "unknown" },
    };
  }

  const buffer = readFileSync(source.uri);
  return {
    kind: "image",
    uri: source.uri,
    binary: buffer,
    meta: { size: buffer.length },
  };
}

// ─── Webpage ────────────────────────────────────────────────────────

async function fetchWebpage(source: DetectedSource): Promise<FetchedContent> {
  const resp = await fetch(source.uri, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Ix/1.0; +https://github.com/ix-infrastructure)",
    },
  });

  if (!resp.ok) {
    throw new Error(`Webpage fetch failed (${resp.status})`);
  }

  const html = await resp.text();
  const title = extractTag(html, "title") ?? source.uri;
  const text = htmlToText(html);
  const description = extractMeta(html, "description") ?? "";

  return {
    kind: "webpage",
    uri: source.uri,
    text,
    meta: {
      title,
      description,
      url: source.uri,
    },
  };
}

// ─── Chat export ────────────────────────────────────────────────────

async function fetchChatExport(source: DetectedSource): Promise<FetchedContent> {
  const raw = readFileSync(source.uri, "utf-8");
  const ext = source.uri.split(".").pop()?.toLowerCase();

  if (ext === "json" || ext === "jsonl") {
    // Try parsing as JSON array or JSONL
    let messages: unknown[];
    if (ext === "jsonl") {
      messages = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } else {
      const parsed = JSON.parse(raw);
      messages = Array.isArray(parsed) ? parsed : parsed.messages ?? [parsed];
    }

    return {
      kind: "chat_export",
      uri: source.uri,
      text: raw,
      meta: {
        format: ext,
        message_count: messages.length,
        messages,
      },
    };
  }

  // CSV — return as raw text, let extraction handle it
  return {
    kind: "chat_export",
    uri: source.uri,
    text: raw,
    meta: { format: "csv" },
  };
}

// ─── Local file (generic) ───────────────────────────────────────────

async function fetchLocalFile(source: DetectedSource): Promise<FetchedContent> {
  const raw = readFileSync(source.uri, "utf-8");
  return {
    kind: "local_file",
    uri: source.uri,
    text: raw,
    meta: {},
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Extract content from a meta tag by name. */
function extractMeta(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const match = html.match(re);
  if (match) return match[1];

  // Try reversed attribute order
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`,
    "i"
  );
  const match2 = html.match(re2);
  return match2 ? match2[1] : null;
}

/** Same as extractMeta but for property-based meta tags (og:, etc). */
function extractMetaContent(html: string, name: string): string | null {
  // Also try matching the content within a <blockquote> or <span> with the class
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  return html.match(re)?.[1] ?? null;
}

/** Extract all values for a repeated meta tag. */
function extractAllMeta(html: string, name: string): string[] {
  const re = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "gi"
  );
  const results: string[] = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push(m[1]);
  }
  return results;
}

/** Extract text content of a tag. */
function extractTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  return html.match(re)?.[1]?.trim() ?? null;
}

/** Extract text content by class name. */
function extractByClass(html: string, className: string): string | null {
  const re = new RegExp(
    `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</`,
    "i"
  );
  const match = html.match(re);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Decode common HTML entities. Run after all tags are stripped. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // &amp; must be last to avoid double-decoding
    .replace(/&amp;/g, "&");
}

/** Strip dangerous HTML blocks (script, style) using iterative replacement. */
function stripBlocks(html: string, tag: string): string {
  const open = new RegExp(`<${tag}[\\s>]`, "i");
  const close = new RegExp(`</${tag}\\s*>`, "i");
  let result = html;
  // Iterate to handle nested/malformed occurrences
  while (open.test(result)) {
    const start = result.search(open);
    const endMatch = close.exec(result.slice(start));
    if (endMatch) {
      result = result.slice(0, start) + result.slice(start + endMatch.index + endMatch[0].length);
    } else {
      // No closing tag — remove everything from the opening tag onward
      result = result.slice(0, start);
      break;
    }
  }
  return result;
}

/** Simple HTML to text conversion — strips tags, decodes entities. */
function htmlToText(html: string): string {
  let text = html;
  // Remove dangerous and non-content blocks iteratively
  for (const tag of ["script", "style", "nav", "header", "footer"]) {
    text = stripBlocks(text, tag);
  }
  return decodeEntities(
    text
      // Convert block elements to newlines
      .replace(/<\/?(?:div|p|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, " ")
  )
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
