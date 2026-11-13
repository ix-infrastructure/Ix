// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from '../client/api.js';
// Wire shape, validated below. Keep parser/native grammar imports out of CLI startup.
type ConfigKind = 'ConfigKey' | 'EnvVar' | 'CliFlag' | 'Route';
interface ConfigBinding {
  kind: ConfigKind;
  key: string;
  role: 'declaration' | 'read' | 'handler';
  symbol: string;
  line: number;
  defaultValue?: string | number | boolean | null;
}

export type BindingReason = 'config key' | 'env var' | 'flag' | 'route';
export const BINDING_REASON: Record<ConfigKind, BindingReason> = {
  ConfigKey: 'config key', EnvVar: 'env var', CliFlag: 'flag', Route: 'route',
};
export interface ConfigMatch extends ConfigBinding {
  path: string;
  symbolId: string;
  symbolKind: string;
}
export interface ConfigLookup {
  query: string;
  matches: ConfigMatch[];
  /** The bounded search filled its page; it may have omitted matching files. */
  truncated: boolean;
}

/** Search only names, then verify typed binding metadata from full stored nodes. */
export async function lookupConfig(client: Pick<IxClient, 'search' | 'nodes'>, query: string, scope: { workspaceId?: string; systemId?: string } = {}): Promise<ConfigLookup> {
  const limit = 200;
  const qualifiedRoute = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE) (\/.*)$/.exec(query);
  // Search the path so all-method registrations are also candidates. Verify
  // both the full path and method below; route patterns are never expanded.
  const hits = await client.search(qualifiedRoute?.[2] ?? query, { ...scope, nameOnly: true, limit });
  const bindingHits = hits.filter(n => ['config_entry', 'configkey', 'envvar', 'cliflag', 'route'].includes(n.kind.toLowerCase()));
  const full = bindingHits.length ? await client.nodes(bindingHits.map(n => n.id), 'full') : { nodes: [] };
  const matches: ConfigMatch[] = [];
  for (const node of full.nodes) {
    const kind = node.attrs?.binding_kind;
    if (typeof kind !== 'string' || !Object.hasOwn(BINDING_REASON, kind) || !Array.isArray(node.attrs.bindings)) continue;
    if (node.name !== query && !(kind === 'Route' && (node.name.slice(node.name.indexOf(' ') + 1) === query
      || (qualifiedRoute && node.name === `* ${qualifiedRoute[2]}`)))) continue;
    const path = node.provenance?.sourceUri ?? (node.provenance as unknown as { source_uri?: string })?.source_uri;
    if (!path) continue;
    for (const value of node.attrs.bindings) {
      if (!value || typeof value !== 'object') continue;
      const f = value as Record<string, unknown>;
      if (f.kind !== kind || f.key !== node.name || typeof f.symbol !== 'string' || typeof f.symbol_id !== 'string' || typeof f.symbol_kind !== 'string'
        || typeof f.line !== 'number' || !['declaration', 'read', 'handler'].includes(String(f.role))) continue;
      matches.push({ kind: kind as ConfigKind, key: node.name, role: f.role as ConfigBinding['role'], symbol: f.symbol,
        line: f.line, path, symbolId: f.symbol_id, symbolKind: f.symbol_kind,
        ...(f.defaultValue === null || ['string', 'number', 'boolean'].includes(typeof f.defaultValue) ? { defaultValue: f.defaultValue as ConfigBinding['defaultValue'] } : {}),
      });
    }
  }
  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.role.localeCompare(b.role));
  return { query, matches, truncated: hits.length >= limit };
}

/** Exact, bounded candidates; route patterns are preserved, never interpreted as regex. */
export function bindingCandidates(text: string): Array<{ query: string; reason: BindingReason }> {
  const candidates: Array<{ query: string; reason: BindingReason }> = [];
  const add = (query: string, reason: BindingReason) => {
    if (!candidates.some(c => c.query === query && c.reason === reason)) candidates.push({ query, reason });
  };
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`"']*)/g)) add(`${m[1]} ${m[2].replace(/[.,;]+$/, '')}`, 'route');
  for (const m of text.matchAll(/(?:^|[\s`"'(])(--?[A-Za-z][\w-]*)/g)) add(m[1], 'flag');
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|HTTP|HTTPS)$/.test(m[0])) add(m[0], 'env var');
  for (const m of text.matchAll(/\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+\b/g)) add(m[0], 'config key');
  for (const m of text.matchAll(/`(\/[^\s`]+)`/g)) add(m[1], 'route');
  for (const m of text.matchAll(/`([A-Za-z_]\w*)`/g)) { add(m[1], 'config key'); add(m[1], 'env var'); }
  for (const m of text.matchAll(/\b(config(?:uration)?(?:\s+key)?|setting|environment\s+variable|env(?:\s+var)?)\s+[`"']?([A-Za-z_][\w.-]*)/gi)) {
    add(m[2].replace(/[.,;]+$/, ''), /^env/i.test(m[1]) ? 'env var' : 'config key');
  }
  return candidates.slice(0, 25);
}
