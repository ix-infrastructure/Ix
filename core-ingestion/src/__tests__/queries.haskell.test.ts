import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// tree-sitter-haskell ships no win32/node26 prebuild, so these run green in CI
// (Linux/node24, where it builds) and are skipped locally if the grammar is absent.
const hs = parseFile('/repo/M.hs', 'main = pure ()\n');
const describeFn = hs && hs.language === SupportedLanguages.Haskell ? describe : describe.skip;

describeFn('Haskell queries', () => {
  it('detects language as Haskell', () => {
    expect(parseFile('/repo/M.hs', 'x = 1\n')!.language).toBe(SupportedLanguages.Haskell);
  });

  it('captures functions, top-level binds, data types and classes', () => {
    const result = parseFile('/repo/Service.hs', `
module Data.Service where
getUser :: Int -> IO User
getUser uid = fetchUser uid
config = defaultConfig
data Status = Active | Inactive
class Loggable a where
  logMsg :: a -> String
`);
    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['getUser', 'config', 'Status']));
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'Loggable', kind: 'interface' }),
    );
  });

  it('emits CALLS for bare and module-qualified application', () => {
    const result = parseFile('/repo/Run.hs', `
run xs = process (Map.lookup key xs)
`);
    expect(result).not.toBeNull();
    const calls = result!.relationships
      .filter(r => r.predicate === 'CALLS')
      .map(r => r.dstName);
    expect(calls).toEqual(expect.arrayContaining(['process', 'lookup']));
  });

  it('emits IMPORTS for module imports', () => {
    const result = parseFile('/repo/M.hs', `
import Data.Maybe (fromMaybe)
import qualified Data.Map as Map
`);
    expect(result).not.toBeNull();
    const imports = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.dstName);
    expect(imports).toEqual(expect.arrayContaining(['Data.Maybe', 'Data.Map']));
  });
});
