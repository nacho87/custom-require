import { parse, ParserPlugin } from '@babel/parser';
import * as path from 'path';
import * as fs from 'fs';

export interface RequireMapping {
  variableName: string;
  filePath: string;
  destructuredNames: string[];
}

export interface ExportLocation {
  name: string;
  line: number;
  column: number;
}

export function getASTPlugins(filePath: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = [];
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    plugins.push('typescript');
  }
  if (filePath.endsWith('.jsx') || filePath.endsWith('.tsx')) {
    plugins.push('jsx');
  }
  plugins.push('optionalChaining', 'nullishCoalescingOperator');
  return plugins;
}

export function parseFile(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const plugins = getASTPlugins(filePath);
    return { ast: parse(content, { sourceType: 'module', plugins, errorRecovery: true }), content };
  } catch {
    return null;
  }
}

function isNode(node: unknown): node is { type: string; loc: any } {
  return node !== null && typeof node === 'object' && typeof (node as any).type === 'string';
}

export function findNodePathChain(ast: any, line: number, column: number): any[] {
  const chain: any[] = [];

  function walk(node: any): boolean {
    if (!node || !node.loc) return false;
    const { start, end } = node.loc;
    if (line < start.line || line > end.line) return false;
    if (line === start.line && column < start.column) return false;
    if (line === end.line && column > end.column) return false;

    chain.push(node);

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' ||
          key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isNode(item) && walk(item)) return true;
        }
      } else if (isNode(child)) {
        if (walk(child)) return true;
      }
    }

    return true;
  }

  walk(ast);
  return chain;
}

export function findRequireCalls(ast: any, functionNames: string[]): RequireMapping[] {
  const results: RequireMapping[] = [];

  function walk(node: any) {
    if (!node || !node.type) return;

    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.init && decl.init.type === 'CallExpression') {
          const callee = decl.init.callee;
          if (callee && callee.type === 'Identifier' && functionNames.includes(callee.name)) {
            const args = decl.init.arguments;
            if (args && args.length > 0 && args[0].type === 'StringLiteral') {
              const filePath = args[0].value;

              if (decl.id.type === 'Identifier') {
                results.push({ variableName: decl.id.name, filePath, destructuredNames: [] });
              } else if (decl.id.type === 'ObjectPattern') {
                const names = (decl.id.properties || [])
                  .map((p: any) => p.type === 'ObjectProperty' && p.key?.type === 'Identifier' ? p.key.name : null)
                  .filter(Boolean);
                results.push({ variableName: '', filePath, destructuredNames: names });
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
          if (isNode(item)) walk(item);
        }
      } else if (isNode(child)) {
        walk(child);
      }
    }
  }

  walk(ast);
  return results;
}

function findObjectExprFromVar(ast: any, varName: string): any | null {
  let result: any = null;
  function walk(node: any) {
    if (result || !node || !node.type) return;
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.id?.type === 'Identifier' && decl.id.name === varName &&
            decl.init?.type === 'ObjectExpression') {
          result = decl.init;
          return;
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

function isModuleExportsNode(node: any): boolean {
  if (node?.type !== 'MemberExpression') return false;
  const prop = node.property;
  if (prop?.type !== 'Identifier' || prop.name !== 'exports') return false;
  return node.object?.type === 'Identifier';
}

function extractObjectExports(obj: any, exports: ExportLocation[]) {
  for (const prop of obj.properties || []) {
    if (prop.type === 'ObjectProperty' && prop.key?.type === 'Identifier' && prop.loc) {
      exports.push({ name: prop.key.name, line: prop.loc.start.line, column: prop.loc.start.column });
    }
    if ((prop.type === 'ObjectMethod' || prop.type === 'SpreadElement') && prop.key?.type === 'Identifier' && prop.loc) {
      exports.push({ name: prop.key.name, line: prop.loc.start.line, column: prop.loc.start.column });
    }
  }
}

function extractClassExports(cls: any, exports: ExportLocation[]) {
  for (const method of cls.body?.body || []) {
    if ((method.type === 'ClassMethod' || method.type === 'ClassPrivateMethod') &&
        method.key?.type === 'Identifier' && method.loc) {
      exports.push({ name: method.key.name, line: method.loc.start.line, column: method.loc.start.column });
    }
  }
}

export function findExports(ast: any): ExportLocation[] {
  const exportsList: ExportLocation[] = [];

  function walk(node: any) {
    if (!node || !node.type) return;

    if (node.type === 'ExpressionStatement') {
      const expr = node.expression;
      if (expr?.type === 'AssignmentExpression') {
        const left = expr.left;
        if (isModuleExportsNode(left)) {
          // module.exports = { key: value }
          if (expr.right?.type === 'ObjectExpression') {
            extractObjectExports(expr.right, exportsList);
          }
          // module.exports = class { method() {} }
          if (expr.right?.type === 'ClassExpression') {
            extractClassExports(expr.right, exportsList);
          }
          // module.exports = someVariable (follow the variable)
          if (expr.right?.type === 'Identifier') {
            const obj = findObjectExprFromVar(ast, expr.right.name);
            if (obj) extractObjectExports(obj, exportsList);
          }
        }
        // module.exports.X = ...
        if (left?.type === 'MemberExpression' &&
            left.object?.type === 'MemberExpression' &&
            isModuleExportsNode(left.object) &&
            left.property?.type === 'Identifier' && left.loc) {
          exportsList.push({ name: left.property.name, line: left.loc.start.line, column: left.loc.start.column });
        }
        // exports.X = ...
        if (left?.type === 'MemberExpression' &&
            left.object?.type === 'Identifier' && left.object.name === 'exports' &&
            left.property?.type === 'Identifier' && left.loc) {
          exportsList.push({ name: left.property.name, line: left.loc.start.line, column: left.loc.start.column });
        }
      }
    }

    // ES module exports
    if (node.type === 'ExportNamedDeclaration') {
      const decl = node.declaration;
      if (decl?.type === 'FunctionDeclaration' && decl.id) {
        exportsList.push({ name: decl.id.name, line: decl.id.loc.start.line, column: decl.id.loc.start.column });
      }
      if (decl?.type === 'ClassDeclaration' && decl.id) {
        exportsList.push({ name: decl.id.name, line: decl.id.loc.start.line, column: decl.id.loc.start.column });
      }
      if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations || []) {
          if (d.id?.type === 'Identifier') {
            exportsList.push({ name: d.id.name, line: d.id.loc.start.line, column: d.id.loc.start.column });
          }
        }
      }
      for (const spec of node.specifiers || []) {
        if (spec.type === 'ExportSpecifier' && spec.local?.type === 'Identifier') {
          exportsList.push({ name: spec.local.name, line: spec.local.loc.start.line, column: spec.local.loc.start.column });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' ||
          key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isNode(item)) walk(item);
        }
      } else if (isNode(child)) {
        walk(child);
      }
    }
  }

  walk(ast);
  return exportsList;
}

export function resolveModulePath(baseDir: string, requirePath: string): string | null {
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

  const exact = path.resolve(baseDir, requirePath);

  function tryPath(p: string): string | null {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      if (stat.isFile()) return p;
      if (stat.isDirectory()) {
        for (const ext of extensions) {
          const indexPath = path.join(p, `index${ext}`);
          if (fs.existsSync(indexPath)) return indexPath;
        }
      }
    }
    return null;
  }

  if (path.extname(requirePath)) {
    return tryPath(exact);
  }

  const direct = tryPath(exact);
  if (direct) return direct;

  for (const ext of extensions) {
    const result = tryPath(exact + ext);
    if (result) return result;
  }

  return null;
}

export interface StringLiteralRange {
  value: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export function findRequireStringLiterals(ast: any, functionNames: string[]): StringLiteralRange[] {
  const results: StringLiteralRange[] = [];

  function walk(node: any) {
    if (!node || !node.type) return;

    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee && callee.type === 'Identifier' && functionNames.includes(callee.name)) {
        const args = node.arguments;
        if (args && args.length > 0 && args[0].type === 'StringLiteral' && args[0].loc) {
          const sl = args[0];
          results.push({
            value: sl.value,
            startLine: sl.loc.start.line,
            startCol: sl.loc.start.column,
            endLine: sl.loc.end.line,
            endCol: sl.loc.end.column,
          });
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
  return results;
}
