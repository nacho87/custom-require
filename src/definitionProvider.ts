import * as vscode from 'vscode';
import * as path from 'path';
import {
  findNodePathChain, findRequireCalls, findExports, parseFile,
  resolveModulePath, findRequireStringLiterals, StringLiteralRange, RequireMapping
} from './analyzer';

const astCache = new Map<string, { version: number; ast: any }>();

function getCachedAST(document: vscode.TextDocument): any {
  const cached = astCache.get(document.uri.fsPath);
  if (cached && cached.version === document.version) {
    return cached.ast;
  }
  const result = parseFile(document.uri.fsPath);
  if (result) {
    astCache.set(document.uri.fsPath, { version: document.version, ast: result.ast });
    return result.ast;
  }
  return null;
}

function resolvePath(rawPath: string, baseDir: string): string | null {
  let resolved = resolveModulePath(baseDir, rawPath);
  if (resolved) return resolved;

  // Absolute path fallback: try workspace roots
  if (rawPath.startsWith('/')) {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      resolved = resolveModulePath(folder.uri.fsPath, rawPath);
      if (resolved) return resolved;
      // Also try without leading slash (project-relative convention)
      resolved = resolveModulePath(folder.uri.fsPath, rawPath.slice(1));
      if (resolved) return resolved;
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
      const result = await this.provideDefinitionForIdentifier(deepest, chain, document);
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
    node: any, chain: any[], document: vscode.TextDocument
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
          return this.resolvePropertyDefinition(objName, identifierName, document);
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
    const ast = getCachedAST(document);
    if (ast) {
      const varDecl = findVarDeclarator(ast, identifierName);
      if (varDecl && varDecl.id?.type === 'ObjectPattern') {
        const reqMapping = this.matchRequireCall(varDecl, document);
        if (reqMapping && reqMapping.destructuredNames.includes(identifierName)) {
          return this.findExportInFile(reqMapping.filePath, identifierName);
        }
      }
    }

    return undefined;
  }

  private matchRequireCall(declarator: any, document: vscode.TextDocument): RequireMapping | null {
    const init = declarator.init;
    if (!init || init.type !== 'CallExpression') return null;

    const callee = init.callee;
    if (!callee || callee.type !== 'Identifier' || !this.functionNames.includes(callee.name)) return null;

    const args = init.arguments;
    if (!args || args.length === 0 || args[0].type !== 'StringLiteral') return null;

    const filePath = args[0].value;
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
    objectName: string, propertyName: string, document: vscode.TextDocument
  ): Promise<vscode.Location | undefined> {
    const ast = getCachedAST(document);
    if (!ast) return undefined;

    const requireCalls = findRequireCalls(ast, this.functionNames);
    const match = requireCalls.find(r => r.variableName === objectName || r.destructuredNames.includes(objectName));
    if (!match) return undefined;

    const baseDir = path.dirname(document.uri.fsPath);
    const resolved = resolvePath(match.filePath, baseDir);
    if (!resolved) return undefined;

    return this.findExportInFile(resolved, propertyName);
  }

  private async findExportInFile(targetPath: string, exportName: string): Promise<vscode.Location | undefined> {
    const result = parseFile(targetPath);
    if (!result) return undefined;

    const exports = findExports(result.ast);
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
