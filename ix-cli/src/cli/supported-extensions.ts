// Single source of truth for which file extensions ix discovers and ingests.
//
// This MUST stay in sync with core-ingestion's EXT_MAP (languages.ts): every
// extension a parser handles belongs here, or those files are never walked by
// `ix map` / `ix watch` / stale detection. It previously lived as three drifting
// copies (ingest/watch/stale) that fell behind every new parser — hence one
// shared set. Dockerfile/Makefile and other extensionless files are matched by
// name in the individual commands, not here.
export const SUPPORTED_EXTENSIONS = new Set<string>([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
  ".cs", ".go", ".rb", ".rs", ".php", ".kt", ".kts", ".swift",
  ".scala", ".sc",
  ".yaml", ".yml",
  ".dockerfile",
  ".sql",
  ".json",
  ".toml",
  ".md", ".markdown",
  ".r",
  ".sas",
  ".ex", ".exs",
  ".mk", ".makefile",
  ".lua",
  ".sh", ".bash", ".zsh", ".ksh",
  ".hs", ".lhs",
  ".zig",
  ".html", ".htm", ".xhtml",
  ".xml", ".xsd", ".xsl", ".xslt", ".wsdl",
  ".csproj", ".vbproj", ".fsproj", ".props", ".targets", ".plist",
  ".tf", ".tfvars", ".hcl",
  ".css", ".scss", ".sass", ".less",
  ".tex", ".sty", ".cls", ".ltx", ".latex",
]);
