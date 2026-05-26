export interface ElixirModule {
    name: string;
    line: number;
    behaviours: string[];      
    functions: ElixirFunction[];
    macros: ElixirMacro[];
    structs: ElixirStruct[];
    statements: ElixirStatement[];
}

export interface ElixirFunction {
    name: string;
    arity: number;
    isPrivate: boolean;
    line: number;
    isOTPCallback: boolean;
}

export interface ElixirMacro {
    name: string;
    arity: number;
    isPrivate: boolean;
    line: number;
}

export interface ElixirStruct {
    fields: string[];
    line: number;
}

export interface ElixirStatement {
    kind: 'use' | 'import' | 'alias' | 'require';
    target: string;
    module: string;
    line: number;
}

export interface ElixerAST{
    modules: ElixirModule[];
    isScript: boolean;
}

//Check if elixer file
export function isElixirFile(fileName: string): boolean {
    return fileName.endsWith('.ex') || fileName.endsWith('.exs');
}

export function isScript(fileName: string): boolean {
    return fileName.endsWith('.exs');
}

const OTP_CALLBACKS = new Set([
  'init', 'handle_call', 'handle_cast', 'handle_info',
  'handle_continue', 'terminate', 'code_change',
  'start_link', 'child_spec'
]);

const OTP_BEHAVIOURS = new Set([
  'GenServer', 'Supervisor', 'GenEvent',
  'Agent', 'Task', 'Phoenix.LiveView'
]);

export function parseElixir(content: string, fileName: string): ElixerAST {
    const lines = content.split('\n');
    const ast: ElixerAST = {
        modules: [],
        isScript: isScript(fileName)
    };

    let currentModule: ElixirModule | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const lineNumber = i + 1;

        if (trimmed.startsWith('#')) 
            continue; // Skip comments

        const moduleMatch = trimmed.match(/^defmodule\s+([\w\.]+)\s+do/);
        if (moduleMatch) {
           currentModule = {
                name: moduleMatch[1],
                line: lineNumber,
                behaviours: [],
                functions: [],
                macros: [],
                structs: [],
                statements: []
            };
            ast.modules.push(currentModule);
            continue;
        }

        if (!currentModule) {
            continue; // Skip lines outside of modules
        }

        //capture otp behaviors
        const useMatch = trimmed.match(/^use\s+([\w\.]+)/);
        if (useMatch) {
            const behavior = useMatch[1];
            currentModule.statements.push({kind: 'use', target: behavior, line: lineNumber, module: currentModule.name});
            if (OTP_BEHAVIOURS.has(behavior)) {
                currentModule.behaviours.push(behavior);
            }
            continue;
        }

        const statementMatch = trimmed.match(/^(import|alias|require)\s+([\w\.]+)/);
        if (statementMatch) {
            currentModule.statements.push({
                kind: statementMatch[1] as 'import' | 'alias' | 'require',
                target: statementMatch[2],
                line: lineNumber,
                module: currentModule.name
            });
            continue;
        }

        const macroMatch = trimmed.match(/^(defmacrop?)\s+(\w+)\s*(\(([^)]*)\))?/);
        if (macroMatch) {
            const isPrivate = macroMatch[1] === 'defmacrop';
            const name = macroMatch[2];
            const params = macroMatch[4] ?? '';
            const arity = params.trim() === '' ? 0 : params.split(',').length;
            currentModule.macros.push({name, arity, isPrivate, line: lineNumber});
            continue;
        }

        const functionMatch = trimmed.match(/^(def|defp|defmacro)\s+([\w\?]+)(\((.*?)\))?/);
        if (functionMatch) {
            const isPrivate = functionMatch[1] === 'defp' || functionMatch[1] === 'defmacro';
            const name = functionMatch[2];
            const args = functionMatch[4] ? functionMatch[4].split(',').map(arg => arg.trim()) : [];
            const arity = args.length;
            currentModule.functions.push({
                name,
                arity,
                isPrivate,
                line: lineNumber,
                isOTPCallback: OTP_CALLBACKS.has(name)
            });
            continue;
        }

        const structMatch = trimmed.match(/^defstruct\s+(.+)$/);
        if (structMatch) {
            const fieldStr = structMatch[1];
            const fields = fieldStr
            .replace(/[\[\]]/g, '')
            .split(',')
            .map((f: string) => f.trim().replace(/^:/, '').trim())
            .filter(Boolean);
            currentModule.structs.push({ fields, line: lineNumber });
            continue;
        }
    }
    return ast;
}