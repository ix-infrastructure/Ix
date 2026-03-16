import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { parseFile } = await import(
  pathToFileURL(resolve(process.cwd(), '../core-ingestion/dist/index.js')).href
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseFixture(relativePath) {
  const filePath = resolve(process.cwd(), relativePath);
  const source = readFileSync(filePath, 'utf8');
  return parseFile(filePath, source);
}

const pythonResult = parseFixture(
  '../memory-layer/src/test/resources/fixtures/sample_project/billing_service.py'
);
assert(pythonResult, 'Expected Python fixture to parse');
assert(
  pythonResult.entities.some((entity) => entity.name === 'BillingService'),
  'Expected BillingService entity in Python fixture'
);
assert(
  pythonResult.entities.some((entity) => entity.name === 'calculate_tax'),
  'Expected calculate_tax entity in Python fixture'
);
assert(
  pythonResult.relationships.some((relationship) => relationship.predicate === 'IMPORTS'),
  'Expected IMPORTS relationship in Python fixture'
);

const typeScriptResult = parseFixture(
  '../memory-layer/src/test/resources/fixtures/api.ts'
);
assert(typeScriptResult, 'Expected TypeScript fixture to parse');
assert(
  typeScriptResult.entities.some((entity) => entity.name === 'ApiClient'),
  'Expected ApiClient entity in TypeScript fixture'
);
assert(
  typeScriptResult.entities.some((entity) => entity.name === 'createClient'),
  'Expected createClient entity in TypeScript fixture'
);
assert(
  typeScriptResult.relationships.some((relationship) => relationship.predicate === 'CALLS'),
  'Expected CALLS relationship in TypeScript fixture'
);

console.log('parser smoke test passed');
