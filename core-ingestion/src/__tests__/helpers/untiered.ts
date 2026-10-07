// Copyright 2026 Ix Infrastructure Inc.

import { resolveEdges as resolveEdgesWithTier } from '../../index.js';

/**
 * `resolveEdges` without the `tier` field. The tests that use it predate
 * tiers and assert edges by whole shape; `resolveEdges.tier.test.ts` covers
 * which tier each resolution path reports.
 */
export const resolveEdges = (...args: Parameters<typeof resolveEdgesWithTier>) =>
  resolveEdgesWithTier(...args).map(({ tier: _tier, ...edge }) => edge);
