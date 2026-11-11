// Copyright 2026 Ix Infrastructure Inc.

export enum SupportedLanguages {
  JavaScript = 'javascript',
  TypeScript = 'typescript',
  Python = 'python',
  Java = 'java',
  C = 'c',
  CPlusPlus = 'cpp',
  CSharp = 'csharp',
  Go = 'go',
  Ruby = 'ruby',
  Rust = 'rust',
  PHP = 'php',
  Kotlin = 'kotlin',
  Swift = 'swift',
  Scala = 'scala',
  YAML = 'yaml',
  Dockerfile = 'dockerfile',
  SQL = 'sql',
  JSON = 'json',
  TOML = 'toml',
  Markdown = 'markdown',
  R = 'r',
  SAS = 'sas',
  Elixir = 'elixir',
  Makefile = 'makefile',
  Lua = 'lua',
  Bash = 'bash',
  PowerShell = 'powershell',
  Haskell = 'haskell',
  Zig = 'zig',
  HTML = 'html',
  XML = 'xml',
  HCL = 'hcl',
  CSS = 'css',
  LaTeX = 'latex',
  Proto = 'proto',
}

const EXT_MAP: Record<string, SupportedLanguages> = {
  '.ts':   SupportedLanguages.TypeScript,
  '.tsx':  SupportedLanguages.TypeScript,
  '.js':   SupportedLanguages.JavaScript,
  '.jsx':  SupportedLanguages.JavaScript,
  '.mjs':  SupportedLanguages.JavaScript,
  '.cjs':  SupportedLanguages.JavaScript,
  '.py':   SupportedLanguages.Python,
  '.pyi':  SupportedLanguages.Python,
  '.java': SupportedLanguages.Java,
  '.c':    SupportedLanguages.C,
  '.h':    SupportedLanguages.C,
  '.cpp':  SupportedLanguages.CPlusPlus,
  '.cc':   SupportedLanguages.CPlusPlus,
  '.cxx':  SupportedLanguages.CPlusPlus,
  '.hpp':  SupportedLanguages.CPlusPlus,
  // CUDA is C++ plus GPU qualifiers; kernel-launch syntax is neutralised at
  // parse time (see blankCudaLaunchConfigs in index.ts).
  '.cu':   SupportedLanguages.CPlusPlus,
  '.cuh':  SupportedLanguages.CPlusPlus,
  '.cs':   SupportedLanguages.CSharp,
  '.go':   SupportedLanguages.Go,
  '.rb':   SupportedLanguages.Ruby,
  '.rs':   SupportedLanguages.Rust,
  '.php':  SupportedLanguages.PHP,
  '.kt':   SupportedLanguages.Kotlin,
  '.kts':  SupportedLanguages.Kotlin,
  '.swift':SupportedLanguages.Swift,
  '.scala':SupportedLanguages.Scala,
  '.sc':   SupportedLanguages.Scala,
  // sbt build definitions are Scala expressions; the Scala grammar parses them
  // as-is, and they are where modules are wired to their dependencies.
  '.sbt':  SupportedLanguages.Scala,
  '.yaml': SupportedLanguages.YAML,
  '.yml':  SupportedLanguages.YAML,
  '.dockerfile': SupportedLanguages.Dockerfile,
  '.sql':  SupportedLanguages.SQL,
  '.proto': SupportedLanguages.Proto,
  '.json': SupportedLanguages.JSON,
  '.toml': SupportedLanguages.TOML,
  '.md':   SupportedLanguages.Markdown,
  '.markdown': SupportedLanguages.Markdown,
  '.r':    SupportedLanguages.R,
  '.sas':  SupportedLanguages.SAS,
  '.ex':   SupportedLanguages.Elixir,
  '.exs':  SupportedLanguages.Elixir,
  '.lua':  SupportedLanguages.Lua,
  '.mk':   SupportedLanguages.Makefile,
  '.makefile': SupportedLanguages.Makefile,
  '.sh':   SupportedLanguages.Bash,
  '.bash': SupportedLanguages.Bash,
  '.zsh':  SupportedLanguages.Bash,
  '.ksh':  SupportedLanguages.Bash,
  '.ps1':  SupportedLanguages.PowerShell,
  '.psm1': SupportedLanguages.PowerShell,
  '.psd1': SupportedLanguages.PowerShell,
  '.hs':   SupportedLanguages.Haskell,
  '.lhs':  SupportedLanguages.Haskell,
  '.zig':  SupportedLanguages.Zig,
  '.html': SupportedLanguages.HTML,
  '.htm':  SupportedLanguages.HTML,
  '.xhtml': SupportedLanguages.HTML,
  '.xml':  SupportedLanguages.XML,
  '.xsd':  SupportedLanguages.XML,
  '.xsl':  SupportedLanguages.XML,
  '.xslt': SupportedLanguages.XML,
  '.wsdl': SupportedLanguages.XML,
  '.csproj': SupportedLanguages.XML,
  '.vbproj': SupportedLanguages.XML,
  '.fsproj': SupportedLanguages.XML,
  '.props': SupportedLanguages.XML,
  '.targets': SupportedLanguages.XML,
  '.plist': SupportedLanguages.XML,
  '.tf':   SupportedLanguages.HCL,
  '.tfvars': SupportedLanguages.HCL,
  '.hcl':  SupportedLanguages.HCL,
  '.css':  SupportedLanguages.CSS,
  '.scss': SupportedLanguages.CSS,
  '.sass': SupportedLanguages.CSS,
  '.less': SupportedLanguages.CSS,
  '.tex':  SupportedLanguages.LaTeX,
  '.sty':  SupportedLanguages.LaTeX,
  '.cls':  SupportedLanguages.LaTeX,
  '.ltx':  SupportedLanguages.LaTeX,
  '.latex':SupportedLanguages.LaTeX,
};

/**
 * Whole file names (lowercased) that are parsed although their extension says
 * nothing: `path.extname('.bashrc')` is `''`. ix-cli's discovery keeps the same
 * list as `SUPPORTED_FILE_NAMES` (supported-extensions.ts); the
 * extension-parity test fails if the two differ, so a name added here is also
 * walked by `ix map`.
 */
export const FILE_NAME_MAP: Readonly<Record<string, SupportedLanguages>> = {
  'dockerfile':    SupportedLanguages.Dockerfile,
  'makefile':      SupportedLanguages.Makefile,
  'gnumakefile':   SupportedLanguages.Makefile,
  // Common extensionless shell config scripts (dotfiles have no real extension).
  '.bashrc':       SupportedLanguages.Bash,
  '.bash_profile': SupportedLanguages.Bash,
  '.bash_aliases': SupportedLanguages.Bash,
  '.bash_logout':  SupportedLanguages.Bash,
  '.zshrc':        SupportedLanguages.Bash,
  '.zprofile':     SupportedLanguages.Bash,
  '.zshenv':       SupportedLanguages.Bash,
  '.profile':      SupportedLanguages.Bash,
};

export function languageFromPath(filePath: string): SupportedLanguages | null {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  const lowerFileName = fileName.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FILE_NAME_MAP, lowerFileName)) {
    return FILE_NAME_MAP[lowerFileName];
  }
  if (lowerFileName.endsWith('.dockerfile')) {
    return SupportedLanguages.Dockerfile;
  }
  if (lowerFileName.endsWith('.makefile') || lowerFileName.endsWith('.mk')) {
    return SupportedLanguages.Makefile;
  }
  const dotIndex = lowerFileName.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const ext = lowerFileName.slice(dotIndex);
  return EXT_MAP[ext] ?? null;
}
