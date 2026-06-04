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
  Haskell = 'haskell',
  Zig = 'zig',
  HTML = 'html',
}

const EXT_MAP: Record<string, SupportedLanguages> = {
  '.ts':   SupportedLanguages.TypeScript,
  '.tsx':  SupportedLanguages.TypeScript,
  '.js':   SupportedLanguages.JavaScript,
  '.jsx':  SupportedLanguages.JavaScript,
  '.mjs':  SupportedLanguages.JavaScript,
  '.cjs':  SupportedLanguages.JavaScript,
  '.py':   SupportedLanguages.Python,
  '.java': SupportedLanguages.Java,
  '.c':    SupportedLanguages.C,
  '.h':    SupportedLanguages.C,
  '.cpp':  SupportedLanguages.CPlusPlus,
  '.cc':   SupportedLanguages.CPlusPlus,
  '.cxx':  SupportedLanguages.CPlusPlus,
  '.hpp':  SupportedLanguages.CPlusPlus,
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
  '.yaml': SupportedLanguages.YAML,
  '.yml':  SupportedLanguages.YAML,
  '.dockerfile': SupportedLanguages.Dockerfile,
  '.sql':  SupportedLanguages.SQL,
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
  '.hs':   SupportedLanguages.Haskell,
  '.lhs':  SupportedLanguages.Haskell,
  '.zig':  SupportedLanguages.Zig,
  '.html': SupportedLanguages.HTML,
  '.htm':  SupportedLanguages.HTML,
  '.xhtml': SupportedLanguages.HTML,
};

export function languageFromPath(filePath: string): SupportedLanguages | null {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName === 'dockerfile' || lowerFileName.endsWith('.dockerfile')) {
    return SupportedLanguages.Dockerfile;
  }
  if(lowerFileName === 'makefile' || lowerFileName === 'makefile.mk' || lowerFileName.endsWith('.makefile') || lowerFileName.endsWith('.mk') || lowerFileName === 'gnumakefile') {
    return SupportedLanguages.Makefile;
  }
  // Common extensionless shell config scripts (dotfiles have no real extension).
  if (lowerFileName === '.bashrc' || lowerFileName === '.bash_profile' || lowerFileName === '.bash_aliases'
    || lowerFileName === '.zshrc' || lowerFileName === '.zprofile' || lowerFileName === '.profile'
    || lowerFileName === '.zshenv' || lowerFileName === '.bash_logout') {
    return SupportedLanguages.Bash;
  }
  const dotIndex = lowerFileName.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const ext = lowerFileName.slice(dotIndex);
  return EXT_MAP[ext] ?? null;
}
