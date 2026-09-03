import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const parse = (source: string, path = '/repo/api.proto') => parseFile(path, source)!;
const named = (source: string) =>
  parse(source).entities.map((entity) => `${entity.kind}:${entity.name}`);
const rels = (source: string, predicate: string) =>
  parse(source).relationships
    .filter((relationship) => relationship.predicate === predicate)
    .map((relationship) => `${relationship.srcName}->${relationship.dstName}`);

describe('Protocol Buffers', () => {
  it('detects the language and captures messages, enums and services', () => {
    const result = parse(`syntax = "proto3";
package ix.v1;

service Store {
  rpc Get(GetRequest) returns (GetResponse);
}

message GetRequest { string key = 1; }
enum Mode { FAST = 0; SLOW = 1; }
`);
    expect(result.language).toBe(SupportedLanguages.Proto);
    expect(result.entities.map((entity) => `${entity.kind}:${entity.name}`)).toEqual(
      expect.arrayContaining([
        'module:ix.v1',
        'interface:Store',
        'method:Get',
        'class:GetRequest',
        'class:Mode',
      ]),
    );
  });

  it('links each rpc to its request and response messages', () => {
    const source = `service Store {
  rpc Get(GetRequest) returns (GetResponse);
  rpc Watch(WatchRequest) returns (stream Event);
}
`;
    expect(rels(source, 'REFERENCES')).toEqual([
      'Get->GetRequest',
      'Get->GetResponse',
      'Watch->WatchRequest',
      'Watch->Event',
    ]);
    expect(rels(source, 'CONTAINS')).toEqual(
      expect.arrayContaining(['Store->Get', 'Store->Watch']),
    );
  });

  it('links a message to the message types of its fields, skipping scalars', () => {
    const source = `message Response {
  bool found = 1;
  string key = 2;
  repeated int64 offsets = 3;
  SyncCursor cursor = 4;
  map<string, Attr> attrs = 5;
  .ix.v1.Outer qualified = 6;
}
`;
    // Scalars (bool/string/int64) contribute nothing; the map's value type and
    // the fully-qualified name resolve to their bare message names.
    expect(rels(source, 'REFERENCES')).toEqual([
      'Response->SyncCursor',
      'Response->Attr',
      'Response->Outer',
    ]);
  });

  it('handles nested definitions and attributes them to their container', () => {
    const result = parse(`message Outer {
  message Inner { string a = 1; }
  enum Kind { A = 0; }
  Inner inner = 1;
}
`);
    expect(result.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['Outer', 'Inner', 'Kind']),
    );
    expect(
      result.relationships
        .filter((relationship) => relationship.predicate === 'CONTAINS')
        .map((relationship) => `${relationship.srcName}->${relationship.dstName}`),
    ).toEqual(expect.arrayContaining(['Outer->Inner', 'Outer->Kind', 'api.proto->Outer']));

    const inner = result.chunks.find((chunk) => chunk.name === 'Inner');
    expect(inner?.container).toBe('Outer');
  });

  it('keeps a oneof from closing its enclosing message early', () => {
    // A oneof adds a brace level without being a definition; the enclosing
    // message must survive its closing brace.
    const result = parse(`message Envelope {
  oneof payload {
    Ping ping = 1;
    Pong pong = 2;
  }
  string id = 3;
}
`);
    const envelope = result.entities.find((entity) => entity.name === 'Envelope');
    expect(envelope!.lineEnd).toBe(7);
    expect(rels('message Envelope {\n  oneof payload {\n    Ping ping = 1;\n  }\n}\n', 'REFERENCES'))
      .toEqual(['Envelope->Ping']);
  });

  it('ignores braces and keywords inside comments and string options', () => {
    const result = parse(`syntax = "proto3";
option go_package = "github.com/x/y{not_a_brace}";
// message Commented { }
/* service Blocked {
   rpc Nope(A) returns (B);
} */
message Real { string a = 1; }
`);
    expect(result.entities.map((entity) => entity.name)).not.toEqual(
      expect.arrayContaining(['Commented', 'Blocked', 'Nope']),
    );
    expect(result.entities.map((entity) => entity.name)).toContain('Real');
  });

  it('records imports by file name and keeps the raw specifier', () => {
    const result = parse(`import "google/protobuf/timestamp.proto";
import public "shared/common.proto";
`);
    const imports = result.relationships.filter((r) => r.predicate === 'IMPORTS');
    expect(imports.map((r) => r.dstName)).toEqual(['timestamp.proto', 'common.proto']);
    expect(imports[0].importRaw).toBe('google/protobuf/timestamp.proto');
  });

  it('handles single-line and empty messages', () => {
    expect(named('message Empty {}\nmessage OneLine { string a = 1; }\n')).toEqual(
      expect.arrayContaining(['class:Empty', 'class:OneLine']),
    );
  });

  it('closes an unterminated definition at end of file instead of dropping it', () => {
    const result = parse('message Truncated {\n  string a = 1;\n');
    expect(result.entities.map((entity) => entity.name)).toContain('Truncated');
  });
});
