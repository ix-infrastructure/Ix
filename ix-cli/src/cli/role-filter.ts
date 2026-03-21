export type EntityRole = 'production' | 'test' | 'fixture' | 'generated' | 'external' | 'tooling';

export const TEST_ROLES = new Set<string>(['test', 'fixture']);

export interface RoleFilterOpts {
  includeTests?: boolean;
  testsOnly?: boolean;
}

export function getNodeRole(node: any): string {
  return node.attrs?.role ?? 'production';
}

export function isTestOrFixture(node: any): boolean {
  return TEST_ROLES.has(getNodeRole(node));
}

/**
 * Filter a list of nodes based on role filter opts.
 * Returns the filtered list plus a count of how many test/fixture nodes were hidden.
 */
export function applyRoleFilter<T>(
  nodes: T[],
  opts: RoleFilterOpts,
): { filtered: T[]; hiddenTestCount: number } {
  if (opts.testsOnly) {
    return { filtered: nodes.filter(n => isTestOrFixture(n as any)), hiddenTestCount: 0 };
  }
  if (opts.includeTests) {
    return { filtered: nodes, hiddenTestCount: 0 };
  }
  const production = nodes.filter(n => !isTestOrFixture(n as any));
  const tests = nodes.filter(n => isTestOrFixture(n as any));
  if (production.length > 0) {
    return { filtered: production, hiddenTestCount: tests.length };
  }
  // No production matches — show tests rather than returning nothing
  return { filtered: tests, hiddenTestCount: 0 };
}

/**
 * Returns a hint string if any test/fixture nodes were hidden, otherwise null.
 */
export function roleHint(hiddenTestCount: number): string | null {
  if (hiddenTestCount === 0) return null;
  const s = hiddenTestCount === 1 ? 'candidate' : 'candidates';
  return `${hiddenTestCount} test/fixture ${s} hidden. Use --include-tests to include.`;
}
