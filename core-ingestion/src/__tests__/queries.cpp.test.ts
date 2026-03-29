import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('C++ queries', () => {
  it('normalizes include targets without truncating path segments or leaving angle brackets', () => {
    const result = parseFile(
      '/repo/include/KimeraRPGO/outlier/Pcm.h',
      `
#include <gtsam/nonlinear/Values.h>
#include <Eigen/Dense>
#include "KimeraRPGO/utils/GraphUtils.h"

class Pcm : public OutlierRemoval {};
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['Pcm']),
    );

    const importTargets = result!.relationships
      .filter((relationship) => relationship.predicate === 'IMPORTS')
      .map((relationship) => relationship.dstName);

    expect(importTargets).toEqual(
      expect.arrayContaining([
        'gtsam/nonlinear/Values.h',
        'Eigen/Dense',
        'KimeraRPGO/utils/GraphUtils.h',
      ]),
    );
    expect(importTargets.some((name) => name.endsWith('>'))).toBe(false);
  });
});
