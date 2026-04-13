import Parser from 'tree-sitter';
import Scala from 'tree-sitter-scala';

const parser = new Parser();
parser.setLanguage(Scala);

const src = `
import ix.memory.model.NodeKind
import ix.memory.model._
import ix.memory.model.{NodeKind, GraphNode}
import ix.memory.db.{GraphQueryApi => GQA}
`;

const tree = parser.parse(src);

function walk(node, depth = 0) {
  const preview = node.childCount === 0 ? ` "${node.text.slice(0, 50)}"` : '';
  console.log(' '.repeat(depth * 2) + node.type + preview);
  for (const child of node.children) walk(child, depth + 1);
}

walk(tree.rootNode);
