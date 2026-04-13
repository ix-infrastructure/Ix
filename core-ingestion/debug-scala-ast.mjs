import Parser from 'tree-sitter';
import Scala from 'tree-sitter-scala';

const parser = new Parser();
parser.setLanguage(Scala);

const src = `
package ix.memory.model

case class GraphNode(id: String, kind: NodeKind, name: String)

def filterByKind(kind: NodeKind): List[GraphNode] = ???

val x: NodeKind = NodeKind.Class
`;

const tree = parser.parse(src);

function walk(node, depth = 0) {
  const preview = node.childCount === 0 ? ` "${node.text.slice(0, 30)}"` : '';
  console.log(' '.repeat(depth * 2) + node.type + preview);
  for (const child of node.children) walk(child, depth + 1);
}

walk(tree.rootNode);
