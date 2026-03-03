package ix.memory.ingestion

import ix.memory.ingestion.parsers.{TreeSitterPythonParser, TypeScriptParser}

/**
 * Routes file paths to the appropriate language parser.
 * Supports Python (.py), TypeScript (.ts), and TSX (.tsx) files.
 */
class ParserRouter {
  private val pythonParser = new TreeSitterPythonParser()
  private val tsParser     = new TypeScriptParser()

  def parserFor(filePath: String): Option[Parser] = {
    if (filePath.endsWith(".py")) Some(pythonParser)
    else if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) Some(tsParser)
    else None
  }
}
