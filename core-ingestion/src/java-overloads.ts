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

interface Candidate {
  index: number;
  varargs: boolean;
  /** Per argument with a known type: its fit. */
  fits: Fit[];
}

/**
 * The overload a call of this shape calls: an index into `signatures`, the
 * erased parameter lists of one `Container.name` in declaration order (see
 * `FileSummary.overloads`). 0, the first overload, also stands for "cannot
 * tell": no overload takes that many arguments, or more than one could be the
 * target. Two overloads that fit equally well are never guessed between.
 */
export function selectJavaOverload(signatures: readonly string[], shape: CallShape): number {
  const candidates: Candidate[] = [];
  const known = (shape.argTypes ?? []).some(t => t != null);
  for (let index = 0; index < signatures.length; index++) {
    const params = signatures[index] === '' ? [] : signatures[index].split(',');
    const varargs = params.length > 0 && params[params.length - 1].endsWith('...');
    if (varargs ? shape.argc < params.length - 1 : shape.argc !== params.length) continue;
    const fits: Fit[] = [];
    for (let i = 0; known && i < shape.argc; i++) {
      const arg = shape.argTypes?.[i];
      if (arg == null) continue;
      if (!varargs || i < params.length - 1) { fits.push(fit(arg, params[i])); continue; }
      const element = params[params.length - 1].slice(0, -3);
      const asElement = fit(arg, element);
      // The one argument in the varargs position can also be the array itself.
      const asArray = shape.argc === params.length ? fit(arg, `${element}[]`) : 'no';
      fits.push(asElement === 'no' ? asArray : asElement === 'maybe' && typeof asArray === 'object' ? asArray : asElement);
    }
    candidates.push({ index, varargs, fits });
  }
  if (candidates.length === 0) return 0;
  if (candidates.length === 1) return candidates[0].index;
  if (!known) {
    // By count alone, a fixed-arity overload is tried before a varargs one.
    const fixed = candidates.filter(c => !c.varargs);
    return fixed.length === 1 ? fixed[0].index : 0;
  }
  const viable = candidates.filter(c => !c.fits.includes('no'));
  if (viable.length === 0) return 0;
  if (viable.length === 1) return viable[0].index;
  if (viable.some(c => c.fits.includes('maybe'))) {
    // An overload that might fit through a hierarchy this cannot see can only
    // lose to one that takes every known argument as exactly its own type.
    const exact = viable.filter(c => !c.varargs && c.fits.every(f => typeof f === 'object' && f.rank === 4));
    return exact.length === 1 ? exact[0].index : 0;
  }
  // Java's phases: without boxing, then with it, then varargs. The first phase
  // with a fit decides; within it the most specific overload wins.
  const phase = (c: Candidate): number => c.varargs ? 3 : c.fits.some(f => (f as { boxed: boolean }).boxed) ? 2 : 1;
  const first = Math.min(...viable.map(phase));
  const inPhase = viable.filter(c => phase(c) === first);
  const rank = (c: Candidate, i: number): number => (c.fits[i] as { rank: number }).rank;
  const best = inPhase.filter(c => inPhase.every(other => other === c ||
    (c.fits.every((_, i) => rank(c, i) >= rank(other, i)) && c.fits.some((_, i) => rank(c, i) > rank(other, i)))));
  return best.length === 1 ? best[0].index : 0;
}

/**
 * The overloads the call sites of one relationship call: the distinct indices
 * `selectJavaOverload` gives its shapes, ascending.
 */
export function selectJavaOverloads(signatures: readonly string[], shapes: readonly CallShape[]): number[] {
  return [...new Set(shapes.map(shape => selectJavaOverload(signatures, shape)))].sort((a, b) => a - b);
}
