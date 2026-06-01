import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  findNodePathChain, findRequireCalls, findExports, parseFile,
  resolveModulePath, findRequireStringLiterals, isMatchingRequireCall,
  RequireMapping, ExportLocation
} from './analyzer';

interface CachedFile {
  version: number;
  ast: any;
  exports: ExportLocation[] | null;
  requireCalls: { key: string; result: RequireMapping[] } | null;
}

class LRUMap<K, V> {
  private max: number;
  private map: Map<K, V>;

  constructor(max: number) {
    this.max = max;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  delete(key: K) {
    this.map.delete(key);
  }
}

const fileCache = new LRUMap<string, CachedFile>(50);

function getCachedAST(document: vscode.TextDocument): any {
  const cached = fileCache.get(document.uri.fsPath);
  if (cached && cached.version === document.version) {
    return cached.ast;
  }
  const result = parseFile(document.uri.fsPath);
  if (result) {
    fileCache.set(document.uri.fsPath, {
      version: document.version, ast: result.ast, exports: null, requireCalls: null
    });
    return result.ast;
  }
  return null;
}

function getFileAST(filePath: string): any {
  const cached = fileCache.get(filePath);
  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    if (cached && cached.version === mtime) {
      return cached.ast;
    }
    const result = parseFile(filePath);
    if (result) {
      fileCache.set(filePath, {
        version: mtime, ast: result.ast, exports: null, requireCalls: null
      });
      return result.ast;
    }
  } catch {
    // file might not exist or be inaccessible
  }
  return null;
}

function getCachedExports(filePath: string): ExportLocation[] {
  const ast = getFileAST(filePath);
  if (!ast) return [];
  const cached = fileCache.get(filePath);
  if (cached && cached.exports) {
    return cached.exports;
  }
  const exports = findExports(ast);
  if (cached) {
    cached.exports = exports;
  }
  return exports;
}

function getCachedRequireCalls(ast: any, functionNames: string[], filePath: string): RequireMapping[] {
  const key = functionNames.slice().sort().join(',');
  const cached = fileCache.get(filePath);
  if (cached && cached.requireCalls && cached.requireCalls.key === key) {
    return cached.requireCalls.result;
  }
  const result = findRequireCalls(ast, functionNames);
  if (cached) {
    cached.requireCalls = { key, result };
  }
  return result;
}

function resolvePath(rawPath: string, baseDir: string): string | null {
  let resolved = resolveModulePath(baseDir, rawPath);
  if (resolved) return resolved;

  if (rawPath.startsWith('/')) {
    // Try from baseDir without leading / (project-relative fallback)
    resolved = resolveModulePath(baseDir, rawPath.slice(1));
    if (resolved) return resolved;

    // Try each workspace folder
    for (const folder of vscode.workspace.workspaceFolders || []) {
      resolved = resolveModulePath(folder.uri.fsPath, rawPath);
      if (resolved) return resolved;
      resolved = resolveModulePath(folder.uri.fsPath, rawPath.slice(1));
      if (resolved) return resolved;
    }

    // Last resort: walk up from baseDir trying the relative path
    let current = baseDir;
    while (true) {
      const testPath = path.join(current, rawPath.slice(1));
      if (fs.existsSync(testPath)) {
        const stat = fs.statSync(testPath);
        if (stat.isFile()) return testPath;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return null;
}

function findVarDeclarator(ast: any, name: string): any {
  let result: any = null;
  function walk(node: any) {
    if (result || !node || !node.type) return;
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.id?.type === 'Identifier' && decl.id.name === name) {
          result = decl;
          return;
        }
        if (decl.id?.type === 'ObjectPattern') {
          for (const prop of decl.id.properties || []) {
            if (prop.type === 'ObjectProperty') {
              const key = prop.key?.type === 'Identifier' ? prop.key.name : null;
              const val = prop.value?.type === 'Identifier' ? prop.value.name : null;
              if (key === name || val === name) {
                result = decl;
                return;
              }
            }
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' ||
          key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === 'string') walk(item);
        }
      } else if (child && typeof child.type === 'string') {
        walk(child);
      }
    }
  }
  walk(ast);
  return result;
}

export class MyRequireDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private functionNames: string[]) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
    const ast = getCachedAST(document);
    if (!ast) return undefined;

    const line = position.line + 1;
    const column = position.character;
    const chain = findNodePathChain(ast, line, column);
    if (chain.length === 0) return undefined;

    const deepest = chain[chain.length - 1];

    if (deepest.type === 'StringLiteral') {
      return this.provideDefinitionForStringLiteral(deepest, chain, document);
    }

    if (deepest.type === 'Identifier') {
      const result = await this.provideDefinitionForIdentifier(deepest, chain, document, ast);
      if (result) return result;
    }

    return undefined;
  }

  private provideDefinitionForStringLiteral(
    _node: any, chain: any[], document: vscode.TextDocument
  ): vscode.Location | undefined {
    const callExpr = chain.filter((n: any) => n.type === 'CallExpression').pop();
    if (!callExpr) return undefined;

    const callee = callExpr.callee;
    if (!callee || callee.type !== 'Identifier' || !this.functionNames.includes(callee.name)) {
      return undefined;
    }

    const args = callExpr.arguments;
    if (!args || args.length === 0 || args[0].type !== 'StringLiteral') return undefined;

    const rawPath = args[0].value;
    const baseDir = path.dirname(document.uri.fsPath);
    const resolvedPath = resolvePath(rawPath, baseDir);
    if (!resolvedPath) return undefined;

    return new vscode.Location(vscode.Uri.file(resolvedPath), new vscode.Position(0, 0));
  }

  private async provideDefinitionForIdentifier(
    node: any, chain: any[], document: vscode.TextDocument, ast: any
  ): Promise<vscode.Location | undefined> {
    const identifierName = node.name;
    if (!identifierName) return undefined;

    // Case A: property access e.g. Front.getValue
    const memberExpr = chain.filter((n: any) => n.type === 'MemberExpression').pop();
    if (memberExpr) {
      const prop = memberExpr.property;
      if (prop && prop.type === 'Identifier' && prop === node) {
        const objName = memberExpr.object?.type === 'Identifier' ? memberExpr.object.name : null;
        if (objName) {
          return this.resolvePropertyDefinition(objName, identifierName, document, ast);
        }

        // Case A2: inline require call e.g. myRequire('/path').getValue()
        if (memberExpr.object?.type === 'CallExpression') {
          const callee = memberExpr.object.callee;
          if (callee && callee.type === 'Identifier' && this.functionNames.includes(callee.name)) {
            const args = memberExpr.object.arguments;
            if (args && args.length > 0 && args[0]?.type === 'StringLiteral') {
              const rawPath = args[0].value;
              const baseDir = path.dirname(document.uri.fsPath);
              const resolvedPath = resolvePath(rawPath, baseDir);
              if (resolvedPath) {
                return this.findExportInFile(resolvedPath, identifierName);
              }
            }
          }
        }
      }
    }

    // Case B: part of destructured pattern e.g. const { getEjemplo } = myRequire(...)
    const objPattern = chain.filter((n: any) => n.type === 'ObjectPattern').pop();
    if (objPattern) {
      const varDecl = chain.filter((n: any) => n.type === 'VariableDeclarator').pop();
      if (varDecl && varDecl.id === objPattern) {
        const reqMapping = this.matchRequireCall(varDecl, document);
        if (reqMapping && reqMapping.destructuredNames.includes(identifierName)) {
          return this.findExportInFile(reqMapping.filePath, identifierName);
        }
      }
    }

    // Case C: standalone identifier e.g. console.log(getEjemplo)
    const varDecl = findVarDeclarator(ast, identifierName);
    if (varDecl && varDecl.id?.type === 'ObjectPattern') {
      const reqMapping = this.matchRequireCall(varDecl, document);
      if (reqMapping && reqMapping.destructuredNames.includes(identifierName)) {
        return this.findExportInFile(reqMapping.filePath, identifierName);
      }
    }

    return undefined;
  }

  private matchRequireCall(declarator: any, document: vscode.TextDocument): RequireMapping | null {
    const init = declarator.init;
    if (!isMatchingRequireCall(init, this.functionNames)) return null;

    const filePath = init.arguments[0].value;
    const baseDir = path.dirname(document.uri.fsPath);
    const resolvedPath = resolvePath(filePath, baseDir);
    if (!resolvedPath) return null;

    if (declarator.id.type === 'Identifier') {
      return { variableName: declarator.id.name, filePath: resolvedPath, destructuredNames: [] };
    } else if (declarator.id.type === 'ObjectPattern') {
      const names = (declarator.id.properties || [])
        .map((p: any) => p.type === 'ObjectProperty' && p.key?.type === 'Identifier' ? p.key.name : null)
        .filter(Boolean);
      return { variableName: '', filePath: resolvedPath, destructuredNames: names };
    }

    return null;
  }

  private async resolvePropertyDefinition(
    objectName: string, propertyName: string, document: vscode.TextDocument, ast: any
  ): Promise<vscode.Location | undefined> {
    const requireCalls = getCachedRequireCalls(ast, this.functionNames, document.uri.fsPath);
    const match = requireCalls.find(r => r.variableName === objectName || r.destructuredNames.includes(objectName));
    if (!match) return undefined;

    const baseDir = path.dirname(document.uri.fsPath);
    const resolved = resolvePath(match.filePath, baseDir);
    if (!resolved) return undefined;

    return this.findExportInFile(resolved, propertyName);
  }

  private async findExportInFile(targetPath: string, exportName: string): Promise<vscode.Location | undefined> {
    const ast = getFileAST(targetPath);
    if (!ast) return undefined;

    const exports = getCachedExports(targetPath);
    const match = exports.find(e => e.name === exportName);
    if (!match) return undefined;

    return new vscode.Location(vscode.Uri.file(targetPath), new vscode.Position(match.line - 1, match.column));
  }
}

export class MyRequireDocumentLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private functionNames: string[]) {}

  provideDocumentLinks(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.DocumentLink[] {
    const ast = getCachedAST(document);
    if (!ast) return [];

    const literals = findRequireStringLiterals(ast, this.functionNames);
    const links: vscode.DocumentLink[] = [];

    for (const lit of literals) {
      const baseDir = path.dirname(document.uri.fsPath);
      const resolvedPath = resolvePath(lit.value, baseDir);
      if (!resolvedPath) continue;

      const range = new vscode.Range(
        new vscode.Position(lit.startLine - 1, lit.startCol),
        new vscode.Position(lit.endLine - 1, lit.endCol)
      );
      const targetUri = vscode.Uri.file(resolvedPath);
      links.push(new vscode.DocumentLink(range, targetUri));
    }

    return links;
  }
}
