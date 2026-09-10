// Copyright 2026 Ix Infrastructure INC

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('C queries', () => {
  it('captures functions, structs, typedefs, macros, and calls', () => {
    const result = parseFile(
      '/repo/connect.c',
      `
#include "curl.h"

typedef struct conn_data {
  int fd;
} conn_data;

static int do_connect(conn_data *c) {
  return open_socket(c->fd);
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['do_connect', 'conn_data']),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'do_connect',
      dstName: 'open_socket',
      predicate: 'CALLS',
    });
  });

  it('captures REFERENCES from typedef type in declaration', () => {
    const result = parseFile(
      '/repo/http.c',
      `
typedef struct Curl_easy Curl_easy;

static int send_request(Curl_easy *data) {
  return 0;
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: expect.any(String),
      dstName: 'Curl_easy',
      predicate: 'REFERENCES',
    });
  });

  it('captures REFERENCES from struct_specifier type in declaration (e.g. const struct Foo bar = {...})', () => {
    const result = parseFile(
      '/repo/ftp.c',
      `
const struct Curl_protocol Curl_protocol_ftp = {
  "FTP",
};
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: expect.any(String),
      dstName: 'Curl_protocol',
      predicate: 'REFERENCES',
    });
  });

  it('captures REFERENCES from struct_specifier in parameter declaration', () => {
    const result = parseFile(
      '/repo/smtp.c',
      `
static int smtp_connect(struct Curl_easy *data, struct connectdata *conn) {
  return 0;
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: expect.any(String),
      dstName: 'Curl_easy',
      predicate: 'REFERENCES',
    });
    expect(result!.relationships).toContainEqual({
      srcName: expect.any(String),
      dstName: 'connectdata',
      predicate: 'REFERENCES',
    });
  });

  it('captures includes as IMPORTS', () => {
    const result = parseFile(
      '/repo/curl_setup.c',
      `
#include "curl.h"
#include <stdlib.h>
      `,
    );

    expect(result).not.toBeNull();
    const importTargets = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.dstName);
    expect(importTargets).toContain('curl.h');
  });

  // BUG-1: #define macros must be classified as 'macro', not 'function'
  it('classifies #define macros as kind macro, not function', () => {
    const result = parseFile(
      '/repo/curl.h',
      `
#ifndef CURLINC_CURL_H
#define CURLINC_CURL_H

#define CURL_STRICTER
#define CURL_EXTERN extern
#define enquote(x) #x
#define expand(x) enquote(x)

void curl_global_init(void);
      `,
    );

    expect(result).not.toBeNull();
    const macroEntities = result!.entities.filter(e =>
      ['CURLINC_CURL_H', 'CURL_STRICTER', 'CURL_EXTERN', 'enquote', 'expand'].includes(e.name),
    );
    expect(macroEntities.length).toBeGreaterThan(0);
    for (const e of macroEntities) {
      expect(e.kind).toBe('macro');
    }

    // Real function must still be 'function'
    const fn = result!.entities.find(e => e.name === 'curl_global_init');
    expect(fn?.kind).toBe('function');
  });
});
