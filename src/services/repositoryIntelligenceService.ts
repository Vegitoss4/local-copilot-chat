import * as vscode from 'vscode';
import * as path from 'path';
import * as ts from 'typescript';
import { WorkspaceManager } from './workspaceManager';
import { PathSecurity } from './pathSecurity';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'function'
  | 'method'
  | 'property'
  | 'enum'
  | 'variable';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
  isExported: boolean;
}

export interface ImportDeclaration {
  source: string;
  importedSymbols: string[];
}

export interface FileIntelligence {
  filePath: string;
  extractionMethod: 'ast' | 'heuristic';
  symbols: CodeSymbol[];
  imports: ImportDeclaration[];
  exports: string[];
}

export interface PackedContextResult {
  tokensEstimate: number;
  contextText: string;
  includedFiles: string[];
}

export class RepositoryIntelligenceService {
  private static _instance: RepositoryIntelligenceService | undefined;
  private _fileIndex: Map<string, FileIntelligence> = new Map();

  public static getInstance(): RepositoryIntelligenceService {
    if (!this._instance) {
      this._instance = new RepositoryIntelligenceService();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  /**
   * Clears the in-memory intelligence index.
   */
  public clear(): void {
    this._fileIndex.clear();
  }

  /**
   * Removes a file from index upon deletion or invalidation.
   */
  public invalidateFile(filePath: string): void {
    this._fileIndex.delete(path.normalize(filePath).toLowerCase());
  }

  /**
   * Checks whether a file path should be excluded (secrets, node_modules, binaries, build outputs).
   */
  public isExcluded(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    const base = path.basename(norm);

    if (
      norm.includes('/node_modules/') ||
      norm.includes('/.git/') ||
      norm.includes('/dist/') ||
      norm.includes('/out/') ||
      norm.includes('/out-test/') ||
      norm.includes('/bin/') ||
      norm.includes('/obj/')
    ) {
      return true;
    }

    if (
      base.startsWith('.env') ||
      base.endsWith('.pem') ||
      base.endsWith('.key') ||
      base.endsWith('.pfx') ||
      base.endsWith('.exe') ||
      base.endsWith('.dll') ||
      base.endsWith('.zip') ||
      base.endsWith('.tar')
    ) {
      return true;
    }

    if (PathSecurity.isInternalStatePath(filePath)) {
      return true;
    }

    return false;
  }

  /**
   * Analyzes file content and indexes its symbols, imports, and exports.
   * Uses TypeScript Compiler AST for TS/JS, and labelled heuristics for other languages.
   */
  public analyzeAndIndex(filePath: string, content: string): FileIntelligence {
    if (this.isExcluded(filePath)) {
      const emptyIntel: FileIntelligence = {
        filePath: path.normalize(filePath),
        extractionMethod: 'heuristic',
        symbols: [],
        imports: [],
        exports: []
      };
      return emptyIntel;
    }

    const ext = path.extname(filePath).toLowerCase();
    const symbols: CodeSymbol[] = [];
    const imports: ImportDeclaration[] = [];
    const exports: string[] = [];
    let method: 'ast' | 'heuristic' = 'heuristic';

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      method = 'ast';
      this._extractTypeScriptAST(filePath, content, symbols, imports, exports);
    } else if (ext === '.py') {
      this._extractPythonSymbols(content, symbols, imports, exports);
    } else if (ext === '.cs') {
      this._extractCSharpSymbols(content, symbols, imports, exports);
    } else {
      this._extractGenericSymbols(content, symbols, imports, exports);
    }

    const fileIntel: FileIntelligence = {
      filePath: path.normalize(filePath),
      extractionMethod: method,
      symbols,
      imports,
      exports
    };

    this._fileIndex.set(fileIntel.filePath.toLowerCase(), fileIntel);
    return fileIntel;
  }

  public getFileIntelligence(filePath: string): FileIntelligence | undefined {
    return this._fileIndex.get(path.normalize(filePath).toLowerCase());
  }

  /**
   * Builds bidirectional dependency edges across all indexed files.
   */
  public getDependencyGraph(): { outgoing: Record<string, string[]>; incoming: Record<string, string[]> } {
    const outgoing: Record<string, string[]> = {};
    const incoming: Record<string, string[]> = {};

    for (const [normPath, intel] of this._fileIndex.entries()) {
      outgoing[normPath] = [];
      if (!incoming[normPath]) {
        incoming[normPath] = [];
      }

      for (const imp of intel.imports) {
        const resolved = this._resolveImportPath(intel.filePath, imp.source);
        if (resolved) {
          const normResolved = resolved.toLowerCase();
          outgoing[normPath].push(normResolved);
          if (!incoming[normResolved]) {
            incoming[normResolved] = [];
          }
          incoming[normResolved].push(normPath);
        }
      }
    }

    return { outgoing, incoming };
  }

  /**
   * Packs high-signal repository intelligence for target file within a strict token budget.
   */
  public packContext(targetFilePath: string, maxTokens: number = 2048): PackedContextResult {
    const normTarget = path.normalize(targetFilePath).toLowerCase();
    const targetIntel = this._fileIndex.get(normTarget);

    const includedFiles: string[] = [];
    const sections: string[] = [];
    let currentTokensEstimate = 0;

    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    if (targetIntel) {
      includedFiles.push(targetIntel.filePath);
      let targetSection = `### File Outline: ${path.basename(targetIntel.filePath)} (${targetIntel.extractionMethod.toUpperCase()})\n`;
      targetSection += `Path: ${targetIntel.filePath}\n`;
      targetSection += `Exports: ${targetIntel.exports.length > 0 ? targetIntel.exports.join(', ') : 'none'}\n`;
      targetSection += `Symbols:\n`;
      for (const sym of targetIntel.symbols) {
        targetSection += `  - [${sym.kind}] ${sym.isExported ? 'export ' : ''}${sym.signature} (line ${sym.line})\n`;
      }
      sections.push(targetSection);
      currentTokensEstimate += estimateTokens(targetSection);
    }

    // Include imported dependencies outline
    if (targetIntel) {
      for (const imp of targetIntel.imports) {
        if (currentTokensEstimate >= maxTokens) break;

        const resolved = this._resolveImportPath(targetIntel.filePath, imp.source);
        if (resolved) {
          const depIntel = this._fileIndex.get(resolved.toLowerCase());
          if (depIntel) {
            includedFiles.push(depIntel.filePath);
            let depSection = `### Dependency: ${path.basename(depIntel.filePath)} (${imp.source})\n`;
            depSection += `Imported: ${imp.importedSymbols.join(', ')}\n`;
            depSection += `Declarations:\n`;

            for (const sym of depIntel.symbols) {
              if (imp.importedSymbols.includes(sym.name) || imp.importedSymbols.includes('*')) {
                depSection += `  ${sym.signature}\n`;
              }
            }

            const tokens = estimateTokens(depSection);
            if (currentTokensEstimate + tokens <= maxTokens) {
              sections.push(depSection);
              currentTokensEstimate += tokens;
            }
          }
        }
      }
    }

    // Include callers/dependents outline
    const graph = this.getDependencyGraph();
    const callers = graph.incoming[normTarget] || [];
    if (callers.length > 0 && currentTokensEstimate < maxTokens) {
      let callerSection = `### Dependents (files importing this):\n`;
      for (const callerPath of callers) {
        const callerIntel = this._fileIndex.get(callerPath);
        if (callerIntel) {
          callerSection += `  - ${path.basename(callerIntel.filePath)} (${callerIntel.filePath})\n`;
        }
      }
      const tokens = estimateTokens(callerSection);
      if (currentTokensEstimate + tokens <= maxTokens) {
        sections.push(callerSection);
        currentTokensEstimate += tokens;
      }
    }

    return {
      tokensEstimate: currentTokensEstimate,
      contextText: sections.join('\n'),
      includedFiles
    };
  }

  /**
   * Generates a concise repository symbols overview suitable for prompt context.
   */
  public getRepositoryOverview(maxTokens: number = 1000): string {
    if (this._fileIndex.size === 0) return '';

    const lines: string[] = ['### Repository Symbols & Exports:'];
    let tokens = 10;

    for (const [normPath, intel] of this._fileIndex.entries()) {
      if (intel.exports.length === 0 && intel.symbols.length === 0) continue;
      const baseName = path.basename(intel.filePath);
      const exportList = intel.exports.join(', ');
      const line = `  - **${baseName}**: exports [${exportList || 'none'}] (${intel.symbols.length} symbols)`;
      const lineTokens = Math.ceil(line.length / 4);
      if (tokens + lineTokens > maxTokens) break;

      lines.push(line);
      tokens += lineTokens;
    }

    return lines.join('\n');
  }

  /**
   * True AST extraction for TypeScript and JavaScript using TypeScript Compiler API.
   */
  private _extractTypeScriptAST(
    filePath: string,
    content: string,
    symbols: CodeSymbol[],
    imports: ImportDeclaration[],
    exports: string[]
  ): void {
    const isTs = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      isTs ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
    );

    const getLine = (node: ts.Node): number => {
      return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    };

    const isExportedNode = (node: ts.Node): boolean => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      return !!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    };

    const visit = (node: ts.Node) => {
      // 1. Static Imports
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const source = node.moduleSpecifier.text;
        const importedSymbols: string[] = [];

        if (node.importClause) {
          if (node.importClause.name) {
            importedSymbols.push(node.importClause.name.text);
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              importedSymbols.push('*');
            } else if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const elem of node.importClause.namedBindings.elements) {
                importedSymbols.push(elem.name.text);
              }
            }
          }
        }
        imports.push({ source, importedSymbols });
      }

      // 1b. Re-exports (export * from './mod' or export { a, b } from './mod')
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const source = node.moduleSpecifier.text;
        const importedSymbols: string[] = [];
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const elem of node.exportClause.elements) {
            importedSymbols.push(elem.name.text);
            exports.push(elem.name.text);
          }
        } else {
          importedSymbols.push('*');
        }
        imports.push({ source, importedSymbols });
      }

      // 1c. Dynamic Imports: import('./lazyModule')
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          imports.push({ source: firstArg.text, importedSymbols: ['*'] });
        }
      }

      // 2. Class Declaration
      else if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const isExported = isExportedNode(node);
        const sig = node.getText(sourceFile).split('{')[0].trim();
        symbols.push({ name, kind: 'class', line: getLine(node), signature: sig, isExported });
        if (isExported) exports.push(name);

        // Class methods and properties
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const mName = member.name.getText(sourceFile);
            const mSig = member.getText(sourceFile).split('{')[0].trim();
            symbols.push({ name: mName, kind: 'method', line: getLine(member), signature: mSig, isExported: false });
          } else if (ts.isPropertyDeclaration(member) && member.name) {
            const pName = member.name.getText(sourceFile);
            symbols.push({ name: pName, kind: 'property', line: getLine(member), signature: member.getText(sourceFile).split('=')[0].trim(), isExported: false });
          }
        }
      }

      // 3. Interface Declaration
      else if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const isExported = isExportedNode(node);
        const sig = node.getText(sourceFile).split('{')[0].trim();
        symbols.push({ name, kind: 'interface', line: getLine(node), signature: sig, isExported });
        if (isExported) exports.push(name);
      }

      // 4. Type Alias Declaration
      else if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const isExported = isExportedNode(node);
        const sig = node.getText(sourceFile).replace(/;?$/, '').trim();
        symbols.push({ name, kind: 'type', line: getLine(node), signature: sig, isExported });
        if (isExported) exports.push(name);
      }

      // 5. Function Declaration
      else if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const isExported = isExportedNode(node);
        const sig = node.getText(sourceFile).split('{')[0].trim();
        symbols.push({ name, kind: 'function', line: getLine(node), signature: sig, isExported });
        if (isExported) exports.push(name);
      }

      // 6. Enum Declaration
      else if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        const isExported = isExportedNode(node);
        const sig = node.getText(sourceFile).split('{')[0].trim();
        symbols.push({ name, kind: 'enum', line: getLine(node), signature: sig, isExported });
        if (isExported) exports.push(name);
      }

      // 7. Variable Statements (const/let arrow functions & constants)
      else if (ts.isVariableStatement(node)) {
        const isExported = isExportedNode(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const isArrow = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
            const kind: SymbolKind = isArrow ? 'function' : 'variable';
            const sig = decl.getText(sourceFile).split('=>')[0].trim();
            symbols.push({ name, kind, line: getLine(decl), signature: sig, isExported });
            if (isExported) exports.push(name);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  /**
   * Heuristic parser for Python
   */
  private _extractPythonSymbols(
    content: string,
    symbols: CodeSymbol[],
    imports: ImportDeclaration[],
    exports: string[]
  ): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      const fromImportMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)$/);
      if (fromImportMatch) {
        const source = fromImportMatch[1];
        const symbolsList = fromImportMatch[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]);
        imports.push({ source, importedSymbols: symbolsList });
        continue;
      }

      const directImportMatch = trimmed.match(/^import\s+([a-zA-Z0-9_.]+)/);
      if (directImportMatch) {
        imports.push({ source: directImportMatch[1], importedSymbols: ['*'] });
        continue;
      }

      const classMatch = line.match(/^class\s+([a-zA-Z0-9_]+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        const name = classMatch[1];
        symbols.push({ name, kind: 'class', line: lineNum, signature: classMatch[0].replace(/:$/, ''), isExported: !name.startsWith('_') });
        if (!name.startsWith('_')) exports.push(name);
        continue;
      }

      const defMatch = line.match(/^(\s*)def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (defMatch) {
        const indent = defMatch[1].length;
        const name = defMatch[2];
        const kind: SymbolKind = indent > 0 ? 'method' : 'function';
        symbols.push({ name, kind, line: lineNum, signature: trimmed.replace(/:$/, ''), isExported: !name.startsWith('_') });
        if (kind === 'function' && !name.startsWith('_')) exports.push(name);
        continue;
      }
    }
  }

  /**
   * Heuristic parser for C#
   */
  private _extractCSharpSymbols(
    content: string,
    symbols: CodeSymbol[],
    imports: ImportDeclaration[],
    exports: string[]
  ): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      const usingMatch = line.match(/^using\s+([a-zA-Z0-9_.]+);/);
      if (usingMatch) {
        imports.push({ source: usingMatch[1], importedSymbols: ['*'] });
        continue;
      }

      const classMatch = line.match(/^(?:public|internal|private)?\s*(?:static|sealed|abstract)?\s*(class|interface)\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        const kind: SymbolKind = classMatch[1] === 'interface' ? 'interface' : 'class';
        const name = classMatch[2];
        const isExported = line.startsWith('public') || line.startsWith('internal');
        symbols.push({ name, kind, line: lineNum, signature: line.split('{')[0].trim(), isExported });
        if (isExported) exports.push(name);
        continue;
      }
    }
  }

  private _extractGenericSymbols(
    content: string,
    symbols: CodeSymbol[],
    imports: ImportDeclaration[],
    exports: string[]
  ): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;
      const match = line.match(/^(?:function|def|class|fn)\s+([a-zA-Z0-9_$]+)/);
      if (match) {
        symbols.push({
          name: match[1],
          kind: 'function',
          line: lineNum,
          signature: line.split('{')[0].trim(),
          isExported: true
        });
        exports.push(match[1]);
      }
    }
  }

  private _resolveImportPath(fromFilePath: string, importSource: string): string | undefined {
    if (!importSource.startsWith('.')) {
      return undefined;
    }
    const dir = path.dirname(fromFilePath);
    const resolvedBase = path.resolve(dir, importSource);

    const candidates = [
      resolvedBase,
      resolvedBase + '.ts',
      resolvedBase + '.tsx',
      resolvedBase + '.js',
      resolvedBase + '.jsx',
      path.join(resolvedBase, 'index.ts'),
      path.join(resolvedBase, 'index.js')
    ];

    for (const c of candidates) {
      if (this._fileIndex.has(c.toLowerCase())) {
        return c;
      }
    }

    return undefined;
  }
}
