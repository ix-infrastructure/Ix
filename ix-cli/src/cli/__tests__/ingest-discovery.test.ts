import { describe, expect, it } from 'vitest';

import { dedupeDiscoveredFilePaths, isSupportedSourceFile } from '../commands/ingest.js';

describe('dedupeDiscoveredFilePaths', () => {
  it('collapses alternate discovered paths that point at the same canonical file', () => {
    const deduped = dedupeDiscoveredFilePaths(
      [
        'C:/repo/staging/src/k8s.io/apiserver/pkg/server/config.go',
        'C:/repo/vendor/k8s.io/apiserver/pkg/server/config.go',
        'C:/repo/cmd/kube-apiserver/app/server.go',
      ],
      (filePath) => {
        if (filePath.includes('/vendor/')) {
          return 'C:/repo/staging/src/k8s.io/apiserver/pkg/server/config.go';
        }
        return filePath;
      },
    );

    expect(deduped).toEqual([
      'C:/repo/staging/src/k8s.io/apiserver/pkg/server/config.go',
      'C:/repo/cmd/kube-apiserver/app/server.go',
    ]);
  });

  it('treats Dockerfile variants as supported source inputs', () => {
    expect(isSupportedSourceFile('Dockerfile')).toBe(true);
    expect(isSupportedSourceFile('deploy/prod.dockerfile')).toBe(true);
  });

  it('treats Makefiles as supported source inputs', () => {
    expect(isSupportedSourceFile('Makefile')).toBe(true);
    expect(isSupportedSourceFile('GNUmakefile')).toBe(true);
    expect(isSupportedSourceFile('build/common.mk')).toBe(true);
    expect(isSupportedSourceFile('README.txt')).toBe(false);
  });
});
