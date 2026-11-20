// Copyright 2026 Ix Infrastructure Inc.

export interface TraceFrame {
  path: string;
  line: number;
  runtime: 'python' | 'v8' | 'jvm' | 'go';
  /** JVM packages disambiguate otherwise identical source basenames. */
  packagePath?: string;
}

/** Parse only runtime frame syntax, never arbitrary prose containing a path. */
export function parseTraceFrame(text: string): TraceFrame | undefined {
  const esm = text.match(/^file:\/\/(\/[^\n]+\.[cm]?[jt]sx?):(\d+)$/);
  if (esm) return frame(esm[1], esm[2], 'v8');
  const python = text.match(/^\s*File ["']([^"']+)["'], line (\d+)/);
  if (python) return frame(python[1], python[2], 'python');
  const jvm = text.match(/^\s*at\s+(?:[\w.$-]+\/)?([\w.$]+)\(([^():]+\.(?:java|scala)):(\d+)\)\s*$/);
  if (jvm) {
    const pkg = jvm[1].split('.').slice(0, -2).join('/');
    return { ...frame(jvm[2], jvm[3], 'jvm'), ...(pkg ? { packagePath: `${pkg}/${jvm[2]}` } : {}) };
  }
  const js = /^\s*at\s/.test(text) ? text.match(/(?:\(|\s)(?:file:\/\/(?:\/(?=[A-Za-z]:))?)?((?:[A-Za-z]:)?[^\s():]+):(\d+)(?::\d+)?\)?\s*$/) : null;
  if (js) return frame(js[1], js[2], 'v8');
  const go = text.match(/^\s+((?:[A-Za-z]:)?[^\r\n]*\.go):(\d+)(?:\s+\+0x[\da-f]+)?\s*$/i);
  if (go) return frame(go[1], go[2], 'go');
  return undefined;
}

function frame(path: string, line: string, runtime: TraceFrame['runtime']): TraceFrame {
  return { path: path.replaceAll('\\', '/'), line: Number(line), runtime };
}
