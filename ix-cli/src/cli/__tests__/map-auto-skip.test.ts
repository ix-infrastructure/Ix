import { afterEach, describe, expect, it } from 'vitest';
import { shouldSkipAutoMap } from '../commands/map.js';

describe('shouldSkipAutoMap', () => {
  afterEach(() => { delete process.env.IX_AUTO_MAP_CLOUD; });

  it('skips an automatic map against a remote backend', () => {
    expect(shouldSkipAutoMap({ auto: true, cloudReady: true })).toBe(true);
  });

  it('never skips a manual map (auto=false), even against a remote backend', () => {
    expect(shouldSkipAutoMap({ auto: false, cloudReady: true })).toBe(false);
  });

  it('never skips an automatic map against a local backend', () => {
    expect(shouldSkipAutoMap({ auto: true, cloudReady: false })).toBe(false);
  });

  it('honors the IX_AUTO_MAP_CLOUD opt-in to allow remote auto-refresh', () => {
    process.env.IX_AUTO_MAP_CLOUD = '1';
    expect(shouldSkipAutoMap({ auto: true, cloudReady: true })).toBe(false);
  });
});
