// Copyright 2026 Ix Infrastructure Inc.

// Single source of truth for which file extensions ix discovers and ingests.
//
// This MUST stay in sync with core-ingestion's EXT_MAP (languages.ts): every
// extension a parser handles belongs here, or those files are never walked by
// `ix map` / `ix watch` / stale detection. It previously lived as three drifting
// copies (ingest/watch/stale) that fell behind every new parser — hence one
// shared set. Files whose name, not extension, makes them source (Dockerfile,
// Makefile, shell dotfiles) are in SUPPORTED_FILE_NAMES below.
export const SUPPORTED_EXTENSIONS = new Set<string>([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".java", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
  ".cu", ".cuh",
  ".cs", ".go", ".rb", ".rs", ".php", ".kt", ".kts", ".swift",
  ".scala", ".sc", ".sbt",
  ".yaml", ".yml",
  ".dockerfile",
  ".sql",
  ".proto",
  ".json",
  ".toml",
  ".md", ".markdown",
  ".r",
  ".sas",
  ".ex", ".exs",
  ".mk", ".makefile",
  ".lua",
  ".sh", ".bash", ".zsh", ".ksh",
  ".ps1", ".psm1", ".psd1",
  ".hs", ".lhs",
  ".zig",
  ".html", ".htm", ".xhtml",
  ".xml", ".xsd", ".xsl", ".xslt", ".wsdl",
  ".csproj", ".vbproj", ".fsproj", ".props", ".targets", ".plist",
  ".tf", ".tfvars", ".hcl",
  ".css", ".scss", ".sass", ".less",
  ".tex", ".sty", ".cls", ".ltx", ".latex",
]);

// Whole file names (lowercased) that are source although `path.extname` gives
// nothing useful: `extname('.bashrc')` is ''. The same list as core-ingestion's
// FILE_NAME_MAP (languages.ts); its extension-parity test fails if they differ,
// as it does for SUPPORTED_EXTENSIONS and EXT_MAP.
export const SUPPORTED_FILE_NAMES: ReadonlySet<string> = new Set<string>([
  "dockerfile", "makefile", "gnumakefile",
  ".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout",
  ".zshrc", ".zprofile", ".zshenv", ".profile",
]);
