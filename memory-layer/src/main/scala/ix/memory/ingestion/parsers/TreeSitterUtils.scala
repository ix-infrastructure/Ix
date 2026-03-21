package ix.memory.ingestion.parsers

import org.treesitter.{TSNode, TSParser, TSTree, TSLanguage}

object TreeSitterUtils {

  /** 1-based line start */
  def lineStart(node: TSNode): Int = node.getStartPoint().getRow() + 1

  /** 1-based line end */
  def lineEnd(node: TSNode): Int = node.getEndPoint().getRow() + 1

  /** Extract source text for a node */
  def nodeText(node: TSNode, source: String): String =
    source.substring(node.getStartByte(), node.getEndByte())

  /** Find named child by field name, returning None if null */
  def fieldChild(node: TSNode, field: String): Option[TSNode] = {
    val child = node.getChildByFieldName(field)
    if (child == null || child.isNull()) None else Some(child)
  }

  /** Find first named child with given type */
  def findChild(node: TSNode, nodeType: String): Option[TSNode] =
    namedChildren(node).find(_.getType() == nodeType)

  /** All named children */
  def namedChildren(node: TSNode): Vector[TSNode] =
    (0 until node.getNamedChildCount()).map(node.getNamedChild).toVector

  /** All named children of a given type */
  def childrenOfType(node: TSNode, nodeType: String): Vector[TSNode] =
    namedChildren(node).filter(_.getType() == nodeType)

  /** All children (named and anonymous) */
  def allChildren(node: TSNode): Vector[TSNode] =
    (0 until node.getChildCount()).map(node.getChild).toVector

  /** Recursively collect all descendants matching a predicate */
  def collectDescendants(node: TSNode, pred: TSNode => Boolean): Vector[TSNode] = {
    val buf = Vector.newBuilder[TSNode]
    def walk(n: TSNode): Unit = {
      if (pred(n)) buf += n
      for (i <- 0 until n.getChildCount()) walk(n.getChild(i))
    }
    walk(node)
    buf.result()
  }

  /** Extract identifier name from a node's "name" field */
  def extractName(node: TSNode, source: String): Option[String] =
    fieldChild(node, "name").map(n => nodeText(n, source))

  /** Loan pattern: parse source, run body, close parser+tree */
  def withParse[A](lang: TSLanguage, source: String)(body: TSNode => A): A = {
    val parser = new TSParser()
    parser.setLanguage(lang)
    val tree = parser.parseString(null, source)
    try body(tree.getRootNode())
    finally { tree.close(); parser.close() }
  }
}
