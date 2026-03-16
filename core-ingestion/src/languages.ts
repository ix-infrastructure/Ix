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
};

export function languageFromPath(filePath: string): SupportedLanguages | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXT_MAP[ext] ?? null;
}
