import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

describe('Bash queries', () => {
  it('detects shell by extension and common dotfiles', () => {
    expect(parseFile('/x/deploy.sh', 'echo hi\n')!.language).toBe(SupportedLanguages.Bash);
    expect(parseFile('/x/run.zsh', 'echo hi\n')!.language).toBe(SupportedLanguages.Bash);
    expect(parseFile('/home/.bashrc', 'alias l=ls\n')!.language).toBe(SupportedLanguages.Bash);
  });

  it('captures both function definition forms', () => {
    const result = parseFile('/x/lib.sh', `
build() { make all; }
function deploy {
  echo deploying
}
`);
    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['build', 'deploy']),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'build', kind: 'function' }),
    );
  });

  it('emits CALLS for command invocations (incl. calls to defined functions)', () => {
    const result = parseFile('/x/run.sh', `
deploy() {
  build
  notify_team
}
`);
    expect(result).not.toBeNull();
    const calls = result!.relationships
      .filter(r => r.predicate === 'CALLS')
      .map(r => r.dstName);
    expect(calls).toEqual(expect.arrayContaining(['build', 'notify_team']));
  });

  it('emits IMPORTS for source and dot includes', () => {
    const result = parseFile('/x/main.sh', `
source ./lib/common.sh
. /etc/profile.d/app.sh
`);
    expect(result).not.toBeNull();
    const raws = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.importRaw);
    expect(raws).toEqual(
      expect.arrayContaining(['./lib/common.sh', '/etc/profile.d/app.sh']),
    );
  });
});
