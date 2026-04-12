/**
 * URL / path type detection for multi-source ingestion.
 *
 * Auto-classifies a user-provided string (URL or local path) into a
 * SourceKind that drives the fetch → extract → transform pipeline.
 */

export type SourceKind =
  | "tweet"
  | "arxiv"
  | "pdf"
  | "image"
  | "webpage"
  | "chat_export"
  | "github"
  | "local_file";

export interface DetectedSource {
  kind: SourceKind;
  /** Original input string (URL or file path). */
  raw: string;
  /** Normalized URL if applicable, otherwise the absolute file path. */
  uri: string;
  /** Extra metadata extracted during detection (e.g. arxiv paper ID). */
  meta: Record<string, string>;
}

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff",
]);

const CHAT_EXTENSIONS = new Set([".json", ".csv", ".jsonl"]);

/**
 * Detect the source type from a URL or file path.
 *
 * Detection order matters — more specific patterns are checked first.
 */
export function detectSource(input: string): DetectedSource {
  const trimmed = input.trim();

  // --- URL-based detection ---
  if (/^https?:\/\//i.test(trimmed)) {
    return detectUrl(trimmed);
  }

  // --- Local file path ---
  return detectLocalFile(trimmed);
}

function detectUrl(url: string): DetectedSource {
  const lower = url.toLowerCase();
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();

  // Twitter / X
  if (host === "twitter.com" || host === "x.com") {
    const tweetMatch = parsed.pathname.match(/\/([^/]+)\/status\/(\d+)/);
    return {
      kind: "tweet",
      raw: url,
      uri: url,
      meta: tweetMatch
        ? { author: tweetMatch[1], tweetId: tweetMatch[2] }
        : {},
    };
  }

  // arXiv
  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
    const paperMatch = parsed.pathname.match(
      /\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/
    );
    return {
      kind: "arxiv",
      raw: url,
      uri: url,
      meta: paperMatch ? { paperId: paperMatch[1] } : {},
    };
  }

  // GitHub — delegate to existing GitHub ingestion
  if (host === "github.com") {
    return {
      kind: "github",
      raw: url,
      uri: url,
      meta: {},
    };
  }

  // Direct PDF link
  if (path.endsWith(".pdf") || lower.includes("content-type=application/pdf")) {
    return {
      kind: "pdf",
      raw: url,
      uri: url,
      meta: {},
    };
  }

  // Direct image link
  const ext = extFrom(path);
  if (ext && IMAGE_EXTENSIONS.has(ext)) {
    return {
      kind: "image",
      raw: url,
      uri: url,
      meta: {},
    };
  }

  // Default: webpage
  return {
    kind: "webpage",
    raw: url,
    uri: url,
    meta: {},
  };
}

function detectLocalFile(filePath: string): DetectedSource {
  const lower = filePath.toLowerCase();
  const ext = extFrom(lower);

  if (ext === ".pdf") {
    return { kind: "pdf", raw: filePath, uri: filePath, meta: {} };
  }

  if (ext && IMAGE_EXTENSIONS.has(ext)) {
    return { kind: "image", raw: filePath, uri: filePath, meta: {} };
  }

  // Chat export heuristic: JSON/CSV/JSONL files with "chat", "slack",
  // "discord", or "messages" in the filename
  if (ext && CHAT_EXTENSIONS.has(ext)) {
    const name = filePath.split("/").pop() ?? "";
    if (/chat|slack|discord|messages|conversation/i.test(name)) {
      return { kind: "chat_export", raw: filePath, uri: filePath, meta: {} };
    }
  }

  return { kind: "local_file", raw: filePath, uri: filePath, meta: {} };
}

function extFrom(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return path.slice(dot).toLowerCase();
}
