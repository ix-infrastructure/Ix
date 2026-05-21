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
  // Text / document types — routed to the text pipeline for semantic extraction
  Text = 'text',
  PDF = 'pdf',
  RST = 'rst',
  TeX = 'tex',
  AsciiDoc = 'asciidoc',
  Org = 'org',
  RTF = 'rtf',
  HTML = 'html',
  XML = 'xml',
  CSV = 'csv',
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
  // Text / document types
  '.txt':      SupportedLanguages.Text,
  '.text':     SupportedLanguages.Text,
  '.log':      SupportedLanguages.Text,
  '.pdf':      SupportedLanguages.PDF,
  '.rst':      SupportedLanguages.RST,
  '.tex':      SupportedLanguages.TeX,
  '.latex':    SupportedLanguages.TeX,
  '.adoc':     SupportedLanguages.AsciiDoc,
  '.asciidoc': SupportedLanguages.AsciiDoc,
  '.org':      SupportedLanguages.Org,
  '.rtf':      SupportedLanguages.RTF,
  '.html':     SupportedLanguages.HTML,
  '.htm':      SupportedLanguages.HTML,
  '.xml':      SupportedLanguages.XML,
  '.svg':      SupportedLanguages.XML,
  '.csv':      SupportedLanguages.CSV,
  '.tsv':      SupportedLanguages.CSV,
};

export function languageFromPath(filePath: string): SupportedLanguages | null {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName === 'dockerfile' || lowerFileName.endsWith('.dockerfile')) {
    return SupportedLanguages.Dockerfile;
  }
  const dotIndex = lowerFileName.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const ext = lowerFileName.slice(dotIndex);
  return EXT_MAP[ext] ?? null;
}
