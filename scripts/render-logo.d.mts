// Types for scripts/render-logo.mjs (imported by ix-cli tests; the CLI spawns
// it as a subprocess, so this file is types-only for the repo's TS surface).
export declare class LogoError extends Error {
  code: number;
}
export declare function resolveColorMode(
  colorArg: string,
  env?: NodeJS.ProcessEnv,
): "truecolor" | "256" | "ascii";
export declare function renderLogo(opts?: {
  width?: number;
  color?: string;
  bg?: "brand" | "none";
  file?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
}): string | {
  ok: boolean;
  tool: string;
  color: string;
  bg: string;
  file: { path: string; bytes: number };
  source: { width: number; height: number };
  grid: { cols: number; rows: number };
  cells: { total: number; ink: number };
  truncated: boolean;
};
