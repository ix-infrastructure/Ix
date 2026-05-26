import * as path from 'path';
import * as fs from 'fs';

const MAKEFILE_PATTERNS = [
    /^Makefile$/,
    /^GNUmakefile$/,
    /^makefile$/,
    /\.mk$/
];

export function isMakefile(filename: string): boolean {
    return MAKEFILE_PATTERNS.some(pattern => pattern.test(filename));
}

export interface MakeVariable {
    name: string;
    operator : '=' | ':=' | '?=' | '+=' | '::=';
    value: string;
    line: number;
}

export interface MakeTarget {
    name: string;
    prerequisites: string[];
    recipe: string[];
    isPhony: boolean;
    line: number;
}

export interface MakeInclude {
    path: string;
    line: number;
}

export interface MakefileAST {
    variables: MakeVariable[];
    targets: MakeTarget[];
    includes: MakeInclude[];
    phonyNames: string[];
}

export type GraphPatchPayload =
    | { kind: 'file'; name: string; path: string; language: string; contains: unknown[] }
    | { kind: 'target'; name: string; path: string; line: number; isPhony: boolean; prerequisites: string[]; contains: { kind: string; name: string; value: string }[] }
    | { kind: 'variable'; name: string; path: string; line: number; operator: string; value: string };


export function parseMakefile(content: string): MakefileAST {
    const lines = content.split(/\r?\n/);
    const ast: MakefileAST = {
        variables: [],
        targets: [],
        includes: [],
        phonyNames: []
    };
    let currentTarget: MakeTarget | null = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        //Skips comments and blanks
        if (line == undefined) {
            continue;
        }
        if(line.startsWith('#') || line.trim() === '') {
            continue;
        }

        //Assigning currentTarget when a target is found
        if (line.includes(':') && line.startsWith('\t')) {
            const [name, ...prereqs] = line.split(':');
            if (!name) continue;
            currentTarget = {
                name: name.trim(),
                prerequisites: prereqs.join(':').trim().split(/\s+/).filter(Boolean),
                recipe: [],
                isPhony: false,
                line: lineNumber
            };
        }

        if(line.startsWith('\t') && currentTarget) {
            const target = currentTarget;
            target.recipe.push(line.trim());
            continue;
        }

        //Variable assignment
        const variableMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(\?=|:=|\+=|=)\s*(.*)$/);
        if (variableMatch) {
            const [, name, operator, value] = variableMatch;
            if (!name || !operator || value == undefined) continue;
            ast.variables.push({
                name: name.trim(),
                operator: operator as MakeVariable['operator'],
                value: value.trim(),
                line: lineNumber
            });
            continue;
        }

        //Include directive
        const includeMatch = line.match(/^include\s+(.+)$/);
        if (includeMatch) {
            if (!includeMatch[1]) continue;
            ast.includes.push({ 
                path: includeMatch[1].trim(),
                line: lineNumber
            });
            continue;
        }

        const targetMatch = line.match(/^([^\s:]+)\s*:(.*)$/);
        if (targetMatch) {
            if(!targetMatch[1] || !targetMatch[2]) continue;
            const name = targetMatch[1].trim();
            const prereqs = targetMatch[2].trim().split(/\s+/).filter(Boolean);
            
            if (name === '.PHONY') {
                ast.phonyNames.push(...prereqs);
                currentTarget = null;
                continue;
            }   
            currentTarget = {
                name,
                prerequisites: prereqs,
                recipe: [],
                isPhony: false,
                line: lineNumber
            };
            ast.targets.push(currentTarget);
        }
    }
    return ast;
}

export function resolvePhonyTargets(ast: MakefileAST): void {
    const phonySet = new Set(ast.phonyNames);
    for (const target of ast.targets) {
        if (phonySet.has(target.name)) {
            target.isPhony = true;
        }
    }
}

export interface ResolvedInclude extends MakeInclude {
  resolvedPath: string | null;  // null if file not found
}

export function resolveIncludes(
    ast: MakefileAST,
    makefileDir: string 
): ResolvedInclude[] {
    return ast.includes.map(include => {
        const resolvedPath = path.resolve(makefileDir, include.path);
        return {
            ...include,
            resolvedPath: fs.existsSync(resolvedPath) ? resolvedPath : null
        };
    });
}

export function emitEntities(
  ast: MakefileAST,
  filePath: string
): GraphPatchPayload[] {
  const patches: GraphPatchPayload[] = [];

  // File entity
  patches.push({
    kind: 'file',
    name: path.basename(filePath),
    path: filePath,
    language: 'makefile',
    contains: []
  });

  // Target entities — each CONTAINS its recipe lines
  for (const target of ast.targets) {
    patches.push({
      kind: 'target',
      name: target.name,
      path: filePath,
      line: target.line,
      isPhony: target.isPhony,
      prerequisites: target.prerequisites,
      contains: target.recipe.map((recipe, idx) => ({
        kind: 'recipe_line',
        name: `${target.name}:recipe:${idx}`,
        value: recipe
      }))
    });
  }

  // Variable entities
  for (const v of ast.variables) {
    patches.push({
      kind: 'variable',
      name: v.name,
      path: filePath,
      line: v.line,
      operator: v.operator,
      value: v.value
    });
  }

  return patches;
}