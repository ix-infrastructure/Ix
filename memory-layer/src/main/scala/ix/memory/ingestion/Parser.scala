package ix.memory.ingestion

/**
 * Common trait for language-specific source code parsers.
 * Both TreeSitterPythonParser and TypeScriptParser implement this.
 */
trait Parser {
  def parse(fileName: String, source: String): ParseResult
}
