// Copyright 2026 Ix Infrastructure Inc.

/**
 * Which overload of a Java method a call site calls (#1139), from what the
 * call site shows on its face: how many arguments, and the type of each
 * argument that is evident without inference. This is a small part of Java's
 * overload resolution, deliberately: it never follows a method's return type,
 * a generic bound or a class hierarchy. Whatever it cannot decide goes to the
 * first overload, which is where every call went before overloads had nodes
 * of their own.
 */

/** One distinct way a relationship's call sites pass arguments. */
export interface CallShape {
  /** Number of arguments. */
  argc: number;
  /**
   * The erased static type of each argument where it is evident (a literal,
   * `new T()`, a cast, a variable with a declared type), else null. Absent
   * when no argument's type is known.
   */
  argTypes?: Array<string | null>;
}

const BOX: Record<string, string> = {
  boolean: 'Boolean', byte: 'Byte', short: 'Short', char: 'Character',
  int: 'Integer', long: 'Long', float: 'Float', double: 'Double',
};
const UNBOX: Record<string, string> = Object.fromEntries(Object.entries(BOX).map(([p, b]) => [b, p]));
const WIDENING = ['byte', 'short', 'int', 'long', 'float', 'double'];
/** Final JDK classes: nothing else is assignable to a parameter of one. */
const FINAL_TYPES = new Set(['String', ...Object.values(BOX)]);
/** What a box or a String also is, besides `Object`. */
const VALUE_SUPERTYPES = new Set(['Comparable', 'Serializable', 'Constable', 'ConstantDesc']);
const ARRAY_SUPERTYPES = new Set(['Cloneable', 'Serializable']);

/** How many primitive widening steps take `from` to `to`; -1 when none do. */
function wideningSteps(from: string, to: string): number {
  const target = WIDENING.indexOf(to);
  // `char` widens to `int` and beyond; nothing widens to it.
  const source = from === 'char' ? 1 : WIDENING.indexOf(from);
  if (source < 0 || target < 0 || target <= source || (from === 'char' && target < 2)) return -1;
  return target - source;
}

/** `java.lang.String` and `Map.Entry` name the same type as `String` and `Entry`. */
function sameType(a: string, b: string): boolean | 'maybe' {
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const simple = (t: string) => t.slice(t.lastIndexOf('.') + 1);
  return a.includes('.') && b.includes('.') && simple(a) === simple(b) ? 'maybe' : false;
}

/** Without a package, as the JDK types above are written. */
const unqualified = (type: string): string => type.replace(/^java\.(?:lang|io|lang\.constant)\./, '');

/**
 * How an argument of a known type fits a parameter. `rank` orders fits of one
 * argument (an exact type is the most specific); `boxed` says the fit needs
 * boxing or unboxing, which Java only tries when no overload fits without.
 * `'maybe'`: it depends on a class hierarchy or a type parameter this cannot
 * see. `'no'`: the argument cannot be passed there.
 */
type Fit = { rank: number; boxed: boolean } | 'maybe' | 'no';

function fit(argument: string, parameter: string): Fit {
  const arg = unqualified(argument);
  const param = unqualified(parameter);
  const argPrimitive = arg in BOX;
  const paramPrimitive = param in BOX;
  if (argPrimitive && paramPrimitive) {
    if (arg === param) return { rank: 4, boxed: false };
    const steps = wideningSteps(arg, param);
    return steps < 0 ? 'no' : { rank: 3.9 - steps / 10, boxed: false };
  }
  if (argPrimitive) {
    if (param === BOX[arg]) return { rank: 2, boxed: true };
    if (param === 'Object') return { rank: 1, boxed: true };
    if (VALUE_SUPERTYPES.has(param) || (param === 'Number' && WIDENING.includes(arg))) return { rank: 1.5, boxed: true };
    // Any other class may be a type parameter (`<T> void put(T value)`).
    return FINAL_TYPES.has(param) || param.endsWith('[]') ? 'no' : 'maybe';
  }
  if (paramPrimitive) {
    const unboxed = UNBOX[arg];
    if (!unboxed) return 'no';
    if (unboxed === param) return { rank: 2, boxed: true };
    const steps = wideningSteps(unboxed, param);
    return steps < 0 ? 'no' : { rank: 1.9 - steps / 10, boxed: true };
  }
  const same = sameType(arg, param);
  if (same === true) return { rank: 4, boxed: false };
  if (same === 'maybe') return 'maybe';
  if (param === 'Object') return { rank: 1, boxed: false };
  const argArray = arg.endsWith('[]');
  const paramArray = param.endsWith('[]');
  if (FINAL_TYPES.has(param)) return 'no';
  if (argArray) {
    if (!paramArray) return ARRAY_SUPERTYPES.has(param) ? { rank: 1.5, boxed: false } : 'maybe';
    // Arrays of classes are covariant; arrays of primitives are not.
    return arg.slice(0, -2) in BOX || param.slice(0, -2) in BOX ? 'no' : 'maybe';
  }
  if (paramArray) return 'no';
  if (FINAL_TYPES.has(arg)) {
    if (VALUE_SUPERTYPES.has(param) || (param === 'Number' && arg !== 'String' && WIDENING.includes(UNBOX[arg])) ||
        (param === 'CharSequence' && arg === 'String')) return { rank: 1.5, boxed: false };
    // A final class has no subclasses, but the parameter may be a type parameter.
    return 'maybe';
  }
  return 'maybe';
}

/** One way a call can apply to an overload. */
interface Application {
  /** The overload: an index into the signatures. */
  index: number;
  /**
   * The call spreads its trailing arguments over a varargs parameter. Passing
   * the array itself is a fixed-arity application, like any other.
   */
  variable: boolean;
  /** The fit of each argument with a known type, in argument order. */
  fits: Fit[];
}

/** Every way `shape` can apply to each signature by its argument count. */
function applicationsByCount(signatures: readonly string[], shape: CallShape): Application[] {
  const applications: Application[] = [];
  const add = (index: number, variable: boolean, params: string[]): void => {
    const fits: Fit[] = [];
    params.forEach((param, i) => {
      const arg = shape.argTypes?.[i];
      if (arg != null) fits.push(fit(arg, param));
    });
    applications.push({ index, variable, fits });
  };
  signatures.forEach((signature, index) => {
    const params = signature === '' ? [] : signature.split(',');
    const last = params[params.length - 1];
    if (!last?.endsWith('...')) {
      if (shape.argc === params.length) add(index, false, params);
      return;
    }
    const head = params.slice(0, -1);
    const element = last.slice(0, -3);
    // `f(T...)` called with one argument there: the array itself, or one element.
    if (shape.argc === params.length) add(index, false, [...head, `${element}[]`]);
    if (shape.argc >= head.length) {
      add(index, true, [...head, ...new Array<string>(shape.argc - head.length).fill(element)]);
    }
  });
  return applications;
}

/** The one overload all of `applications` belong to, else 0: cannot tell. */
function onlyOverload(applications: Application[]): number {
  return applications.length > 0 && applications.every(a => a.index === applications[0].index) ? applications[0].index : 0;
}

/**
 * The overload a call of this shape calls: an index into `signatures`, the
 * erased parameter lists of one `Container.name` in declaration order (see
 * `FileSummary.overloads`). 0, the first overload, also stands for "cannot
 * tell", and a wrong overload is worse than that, so in order:
 *
 * 1. No overload takes that many arguments, or none of those that do can take
 *    an argument whose type is known (the target is elsewhere, inherited
 *    perhaps): 0.
 * 2. Some argument's type is unknown: the overload that alone takes that many
 *    arguments, else 0. The unknown type could turn any other choice around.
 * 3. Every type is known and one overload can take them: that one.
 * 4. A fit depends on a hierarchy or a type parameter this cannot see: the
 *    overload that takes every argument as exactly its own type, else 0.
 * 5. Otherwise Java's phases: without boxing, then with it, then spreading
 *    over varargs. The first phase with a fit decides, and within it the
 *    overload more specific than every other; when there is none, 0.
 */
export function selectJavaOverload(signatures: readonly string[], shape: CallShape): number {
  const byCount = applicationsByCount(signatures, shape);
  const viable = byCount.filter(a => !a.fits.includes('no'));
  if (viable.length === 0) return 0;

  const allKnown = (shape.argTypes ?? []).filter(t => t != null).length === shape.argc;
  if (!allKnown) return byCount.every(a => a.index === byCount[0].index) ? byCount[0].index : 0;
  if (viable.every(a => a.index === viable[0].index)) return viable[0].index;

  if (viable.some(a => a.fits.includes('maybe'))) {
    // Nothing is more specific than an exact fit, whatever the others turn out to be.
    return onlyOverload(viable.filter(a => !a.variable && a.fits.every(f => typeof f === 'object' && f.rank === 4)));
  }

  // Every fit is definite from here on.
  const fitsOf = (a: Application) => a.fits as Array<{ rank: number; boxed: boolean }>;
  const phase = (a: Application): number => a.variable ? 3 : fitsOf(a).some(f => f.boxed) ? 2 : 1;
  const first = Math.min(...viable.map(phase));
  const inPhase = viable.filter(a => phase(a) === first);
  // More specific: no argument fits worse, and one fits better.
  const beats = (a: Application, b: Application): boolean =>
    fitsOf(a).every((f, i) => f.rank >= fitsOf(b)[i].rank) && fitsOf(a).some((f, i) => f.rank > fitsOf(b)[i].rank);
  return onlyOverload(inPhase.filter(a => inPhase.every(b => b.index === a.index || beats(a, b))));
}

/**
 * The overloads the call sites of one relationship call: the distinct indices
 * `selectJavaOverload` gives its shapes, ascending.
 */
export function selectJavaOverloads(signatures: readonly string[], shapes: readonly CallShape[]): number[] {
  return [...new Set(shapes.map(shape => selectJavaOverload(signatures, shape)))].sort((a, b) => a - b);
}
