import { parseFile } from './dist/index.js';
import * as fs from 'fs';

const filePath = process.env.IX_DEBUG_FILE ?? `${process.env.HOME ?? process.env.USERPROFILE}/IX/IX-Memory/memory-layer/src/main/scala/ix/memory/model/Node.scala`;
const source = fs.readFileSync(filePath, 'utf-8');

const result = parseFile(filePath, source);
console.log('Entities:');
for (const e of result.entities) {
  if (e.name === 'NodeKind' || e.kind !== 'file') {
    console.log(`  ${e.kind}:${e.name} (container: ${e.container ?? 'none'})`);
  }
}

// Check fileQKeys logic
const qkMap = new Map();
for (const e of result.entities) {
  if (e.kind === 'file' || e.kind === 'module') continue;
  const container = e.container;
  const qk = container ? `${container}.${e.name}` : e.name;
  const list = qkMap.get(e.name) ?? [];
  list.push(qk);
  qkMap.set(e.name, list);
}
console.log('\nNodeKind qualified keys:', qkMap.get('NodeKind'));
