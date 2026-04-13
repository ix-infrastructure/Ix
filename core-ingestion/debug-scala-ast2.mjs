import Parser from 'tree-sitter';
import Scala from 'tree-sitter-scala';

const parser = new Parser();
parser.setLanguage(Scala);

// Test more patterns: simple return type, var, field type
const src = `
package ix.memory.model

case class GraphNode(id: String, kind: NodeKind, name: String)

def filterByKind(kind: NodeKind): NodeKind = ???

val x: NodeKind = NodeKind.Class

var y: NodeKind = NodeKind.Function

class Foo {
  val field: NodeKind = ???
  def method(k: NodeKind): NodeKind = k
}
`;

const tree = parser.parse(src);

function walk(node, depth = 0) {
  const preview = node.childCount === 0 ? ` "${node.text.slice(0, 30)}"` : '';
  console.log(' '.repeat(depth * 2) + node.type + preview);
  for (const child of node.children) walk(child, depth + 1);
}

walk(tree.rootNode);
