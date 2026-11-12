// Copyright 2026 Ix Infrastructure Inc.

/**
 * Item precision, not byte share or hit rate: each returned item is one trial,
 * including repeated spans. An item is acted on if its file is in the gold
 * patch, or a subsequent read overlaps its span. Callers must pass only reads
 * after the answer, with paths relative to the evaluated repository.
 * No returned items means precision is unknown, not a perfect score.
 */
export function contextPrecision(items, { goldPaths = [], subsequentReads = [] } = {}) {
  const gold = new Set(goldPaths);
  const overlaps = (item, read) => typeof item.path === 'string' && item.path !== '' && item.path === read.path && (
    read.lineStart === undefined || item.lineStart === undefined
    || (item.lineStart <= (read.lineEnd ?? read.lineStart)
      && read.lineStart <= (item.lineEnd ?? item.lineStart))
  );
  const acted = items.filter((item) => gold.has(item.path)
    || subsequentReads.some((read) => overlaps(item, read))).length;
  const topFive = new Set(items.slice(0, 5).map((item) => item.path));
  return {
    items_returned: items.length,
    items_acted_on: acted,
    precision: items.length ? acted / items.length : null,
    file_recall_at_5: gold.size ? [...gold].filter((path) => topFive.has(path)).length / gold.size : null,
  };
}

export function contextPrecisionComparison(beforePaths, afterItems, goldPaths) {
  return {
    before: contextPrecision(beforePaths.map((path) => ({ path })), { goldPaths }),
    after: contextPrecision(afterItems, { goldPaths }),
  };
}
