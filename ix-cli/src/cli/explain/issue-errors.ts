// Copyright 2026 Ix Infrastructure Inc.

import type { RepoAccess } from './text-references.js';

export interface ErrorSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  container?: string;
}

export interface MessageSite {
  path: string;
  line: number;
  template: string;
  symbol?: ErrorSymbol;
}

export interface IssueErrorIndex {
  messages(text: string): MessageSite[];
  enclosing(path: string, line: number): ErrorSymbol | undefined;
}

/** Per-plan fallback index. All message and frame lookups share a small scan
 * budget so error evidence cannot monopolize the briefing's time allowance. */
export async function buildIssueErrorIndex(repo: RepoAccess, files: string[]): Promise<IssueErrorIndex> {
  const { loadIngestionModules } = await import('../commands/ingestion-loader.js');
  const [parser] = await loadIngestionModules();
  const eligible = new Set(files);
  let deadline: number | undefined;
  let reads = 0;
  let bytes = 0;
  const remaining = () => {
    deadline ??= performance.now() + 150;
    return Math.max(0, deadline - performance.now());
  };
  const available = () => remaining() > 0 && reads < 32 && bytes < 512 * 1024;
  const read = (path: string) => {
    if (!available()) return undefined;
    reads++;
    const text = repo.read(path);
    const size = Buffer.byteLength(text ?? '');
    bytes += size;
    return size <= 200 * 1024 && bytes <= 512 * 1024 ? text : undefined;
  };
  const messageCache = new Map<string, MessageSite[]>();
  const parsed = new Map<string, { entities: ErrorSymbol[]; errorSites?: {
    line: number; messageTemplate?: string;
  }[] } | null>();
  const get = (path: string, source?: string) => {
    if (!parsed.has(path)) {
      const text = source ?? read(path);
      const budgetMs = remaining();
      parsed.set(path, text && budgetMs > 0 ? parser.parseFile(path, text, { budgetMs }) : null);
    }
    return parsed.get(path);
  };
  const enclosing = (path: string, line: number) => get(path)?.entities
    .filter(e => (e.kind === 'function' || e.kind === 'method') && e.lineStart <= line && line <= e.lineEnd)
    .sort((a, b) => (a.lineEnd - a.lineStart) - (b.lineEnd - b.lineStart) || b.lineStart - a.lineStart)[0];
  return {
    enclosing,
    messages(text) {
      const cached = messageCache.get(text);
      if (cached) return cached;
      const matches: MessageSite[] = [];
      messageCache.set(text, matches);
      if (!available()) return matches;
      // One batched repository search finds potential sites without reopening
      // every source file when BM25 has a warm index.
      const needles = ['raise', 'throw', 'panic', 'errors.New', 'fmt.Errorf', 'error', 'warn', 'Error', 'Warn'];
      const found = repo.grepAll?.(needles) ?? new Map(needles.map(n => [n, repo.grep(n)]));
      const candidates = new Set([...found.values()].flat().map(hit => hit.path));
      for (const path of candidates) {
        if (!available()) break;
        if (!eligible.has(path)) continue;
        if (!/\.(?:[cm]?[jt]sx?|py|go|java)$/.test(path)) continue;
        const source = read(path);
        if (!source || !/\b(?:raise|throw|panic|errors\.New|fmt\.Errorf)\b|\.\s*(?:error|warn|warning)\s*\(/i.test(source)) continue;
        for (const site of get(path, source)?.errorSites ?? []) {
          if (site.messageTemplate && parser.messageMatches(site.messageTemplate, text)) {
            matches.push({ path, line: site.line, template: site.messageTemplate, symbol: enclosing(path, site.line) });
          }
        }
      }
      // Prefer the most specific literal; stable ties never depend on filesystem order.
      return matches.sort((a, b) => b.template.replaceAll('{}', '').length - a.template.replaceAll('{}', '').length
        || a.path.localeCompare(b.path) || a.line - b.line);
    },
  };
}
