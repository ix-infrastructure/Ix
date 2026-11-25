// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { selectJavaOverload, selectJavaOverloads } from '../java-overloads.js';

/**
 * `selectJavaOverload` on its own (#1139): the erased parameter lists of one
 * method name, the types a call site shows for its arguments (null: not
 * evident), and the overload it must pick. The first overload is also the
 * answer for "cannot tell", so each row puts the tempting wrong overload
 * somewhere else.
 */

type Row = [what: string, signatures: string[], args: Array<string | null>, expected: string];

const pick = (signatures: string[], args: Array<string | null>): string =>
  signatures[selectJavaOverload(signatures, { argc: args.length, ...(args.some(t => t !== null) ? { argTypes: args } : {}) })];

const table = (rows: Row[]): void => {
  it.each(rows)('%s', (_what, signatures, args, expected) => {
    expect(pick(signatures, args)).toBe(expected);
  });
};

describe('selectJavaOverload: picks', () => {
  table([
    ['the issue: handle("a")', ['String', 'Integer', 'String,Integer'], ['String'], 'String'],
    ['the issue: handle(1)', ['String', 'Integer', 'String,Integer'], ['int'], 'Integer'],
    ['the issue: handle("a", 1)', ['String', 'Integer', 'String,Integer'], ['String', 'int'], 'String,Integer'],
    ['the only overload with that many arguments, types unknown', ['String', 'Integer', 'String,Integer'], [null, null], 'String,Integer'],
    ['the only overload with that many arguments, one type unknown', ['String', 'Integer', 'String,Integer'], ['String', null], 'String,Integer'],
    ['the only overload with that many arguments, a fit that may hold', ['String', 'Animal,int'], ['Dog', 'int'], 'Animal,int'],
    ['the only overload with no arguments', ['String', ''], [], ''],
    ['widening before boxing', ['Integer', 'long'], ['int'], 'long'],
    ['boxing when nothing fits without', ['String', 'Integer'], ['int'], 'Integer'],
    ['the nearest primitive', ['String', 'double', 'long'], ['int'], 'long'],
    ['unboxing', ['String', 'int'], ['Integer'], 'int'],
    ['a box to Number', ['String', 'Number'], ['int'], 'Number'],
    ['the box before Object', ['Object', 'Integer'], ['int'], 'Integer'],
    ['a char to int when there is no char', ['String', 'int'], ['char'], 'int'],
    ['a char to char before int', ['int', 'char'], ['char'], 'char'],
    ['a char to int before Character', ['Character', 'int'], ['char'], 'int'],
    ['an Object parameter for a type nothing else takes', ['String', 'int', 'Object'], ['Thing'], 'Object'],
    ['an Object parameter for a boolean', ['String', 'int', 'Object'], ['boolean'], 'Object'],
    ['Object before unboxing', ['int', 'Object'], ['Integer'], 'Object'],
    ['an exact type before Object', ['Object', 'String'], ['String'], 'String'],
    ['an exact type before one that may be a supertype', ['Animal', 'Dog'], ['Dog'], 'Dog'],
    ['an exact type before a type parameter', ['T', 'String'], ['String'], 'String'],
    ['a type parameter when nothing else can take it', ['String', 'T'], ['int'], 'T'],
    ['a qualified name for a simple one', ['int', 'java.lang.String'], ['String'], 'java.lang.String'],
    ['a nested name for its simple one', ['int', 'Entry'], ['Map.Entry'], 'Entry'],
    ['varargs spread, every type known', ['int', 'String...'], ['String', 'String'], 'String...'],
    ['varargs after a fixed parameter', ['String', 'String,Object...'], ['String', 'int', 'String'], 'String,Object...'],
    ['fixed arity before varargs, every type known', ['String,Object...', 'String,String'], ['String', 'String'], 'String,String'],
    ['varargs when the fixed overload cannot take the types', ['int,int', 'String...'], ['String', 'String'], 'String...'],
    ['no arguments: the overload without parameters before varargs', ['String...', ''], [], ''],
    ['no arguments: varargs when nothing else takes none', ['String', 'String...'], [], 'String...'],
    ['the narrower of two varargs', ['long...', 'int...'], ['int', 'int'], 'int...'],
    ['an array passed as the varargs array', ['int', 'int...'], ['int[]'], 'int...'],
    ['an array passed as the varargs array, before Object', ['Object', 'String...'], ['String[]'], 'String...'],
    ['an array parameter', ['String', 'String[]'], ['String[]'], 'String[]'],
    ['a primitive array as one Object of a varargs', ['String', 'Object...'], ['int[]'], 'Object...'],
  ]);
});

describe('selectJavaOverload: falls back to the first overload', () => {
  table([
    // (a) Some argument's type is unknown and more than one overload takes the count.
    ['one unknown argument could turn the choice around', ['Object,String', 'String,Integer'], ['String', null], 'Object,String'],
    ['one unknown argument, the known one fits a single overload exactly', ['Object,int', 'String,int', 'Object,String'], [null, 'String'], 'Object,int'],
    ['one unknown argument, both overloads still fit', ['Object,int', 'String,int'], [null, 'int'], 'Object,int'],
    ['every argument unknown, two overloads of that arity', ['A', 'B'], [null], 'A'],
    ['every argument unknown, three arguments', ['A,B,C', 'D,E,F', 'G'], [null, null, null], 'A,B,C'],
    // (b) A fixed-arity overload is not preferred to a varargs one unseen.
    ['unknown argument: fixed arity or the varargs array', ['int...', 'int'], [null], 'int...'],
    ['unknown argument: String or one of Object...', ['Object...', 'String'], [null], 'Object...'],
    ['unknown arguments: fixed arity or varargs after a fixed parameter', ['String,Object...', 'String,String'], ['String', null], 'String,Object...'],
    // (c) The only overload of that arity cannot take a known argument.
    ['the only overload of that arity takes neither argument', ['String', 'String,String'], ['int', 'int'], 'String'],
    ['the only overload of that arity cannot take the one known argument', ['String', 'String,String'], [null, 'int'], 'String'],
    ['the only varargs overload cannot take a known argument', ['String', 'int,String...'], ['String', 'String'], 'String'],
    ['the only overload of that arity cannot take the one known argument, others can', ['Object', 'String,int', 'Object,Object,Object'], ['int', null], 'Object'],
    // No overload, or no telling.
    ['no overload takes that many arguments', ['String', 'String,String'], [], 'String'],
    ['no overload takes the type', ['String', 'Long'], ['int'], 'String'],
    ['no narrowing of an int', ['String', 'char'], ['int'], 'String'],
    ['two overloads that may both be supertypes', ['String', 'Animal', 'Object'], ['Dog'], 'String'],
    ['a type parameter and a box', ['String', 'T', 'Integer'], ['int'], 'String'],
    ['a same-named type of another package beside Object', ['int', 'a.Thing', 'Object'], ['b.Thing'], 'int'],
    ['two interfaces of a String', ['Object', 'Comparable', 'CharSequence'], ['String'], 'Object'],
    ['each overload better in one argument', ['Object,Object', 'int,Object', 'long,String'], ['int', 'String'], 'Object,Object'],
    ['two varargs that both take no arguments', ['int', 'String...', 'int...'], [], 'int'],
    ['an array that may be the varargs array or one element, beside another overload', ['int', 'Object...', 'Serializable'], ['String[]'], 'int'],
  ]);
});

describe('selectJavaOverloads', () => {
  it('gives the distinct overloads of several call shapes, ascending', () => {
    const signatures = ['String', 'Integer', 'String,Integer'];
    expect(selectJavaOverloads(signatures, [
      { argc: 2 }, { argc: 1, argTypes: ['int'] }, { argc: 1 }, { argc: 1, argTypes: ['String'] }, { argc: 2, argTypes: ['String', null] },
    ])).toEqual([0, 1, 2]);
  });

  it('takes argument types shorter than the count as unknown', () => {
    expect(selectJavaOverload(['Object,String', 'String,Integer'], { argc: 2, argTypes: ['String'] })).toBe(0);
  });
});
