import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

describe('Lua queries', () => {
  it('detects language as Lua', () => {
    const result = parseFile('/repo/mod.lua', `local x = 1\n`);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.Lua);
  });

  it('captures plain, local, dotted and method function declarations', () => {
    const result = parseFile('/repo/mod.lua', `
function top() return 1 end
local function helper(x) return x + 1 end
function M.process(data) return helper(data) end
function obj:method() return self.x end
`);
    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['top', 'helper', 'process']));
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'method', kind: 'method' }),
    );
  });

  it('captures function expressions assigned to a name or table field', () => {
    const result = parseFile('/repo/mod.lua', `
local M = {}
M.handler = function(req) return req end
local cb = function() return 0 end
local T = { run = function() return 1 end }
`);
    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['handler', 'cb', 'run']),
    );
  });

  it('emits CALLS for bare, dotted and method calls', () => {
    const result = parseFile('/repo/mod.lua', `
function run(data)
  local v = helper(data)
  local j = json.encode(v)
  return obj:fetch(j)
end
`);
    expect(result).not.toBeNull();
    const calls = result!.relationships
      .filter(r => r.predicate === 'CALLS')
      .map(r => r.dstName);
    expect(calls).toEqual(expect.arrayContaining(['helper', 'encode', 'fetch']));
  });

  it('emits IMPORTS for require with and without parentheses', () => {
    const result = parseFile('/repo/mod.lua', `
local json = require("cjson")
local http = require "socket.http"
`);
    expect(result).not.toBeNull();
    const imports = result!.relationships.filter(r => r.predicate === 'IMPORTS');
    const raws = imports.map(r => r.importRaw);
    expect(raws).toEqual(expect.arrayContaining(['cjson', 'socket.http']));
  });
});
