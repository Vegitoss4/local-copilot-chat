import * as path from 'path';

export interface MockDocument {
  uri: any;
  content: string;
  getText(range?: any): string;
  positionAt(offset: number): { line: number; character: number };
  save(): Promise<boolean>;
}

export class MockPosition {
  constructor(public line: number, public character: number) {}
}

export class MockRange {
  constructor(public start: MockPosition, public end: MockPosition) {}
}

export class MockWorkspaceEdit {
  public operations: Array<{ type: 'replace' | 'insert'; uri: any; range?: any; newText: string }> = [];

  replace(uri: any, range: any, newText: string) {
    this.operations.push({ type: 'replace', uri, range, newText });
  }

  insert(uri: any, position: any, newText: string) {
    this.operations.push({ type: 'insert', uri, range: new MockRange(position, position), newText });
  }
}

export enum MockDiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export class MockUri {
  public scheme: string = 'file';
  public authority: string = '';
  public path: string;
  public query: string = '';
  public fragment: string = '';
  public fsPath: string;

  constructor(filePath: string) {
    this.fsPath = path.normalize(filePath);
    this.path = this.fsPath.replace(/\\/g, '/');
  }

  static file(f: string): MockUri {
    return new MockUri(f);
  }

  static parse(val: string): MockUri {
    return new MockUri(val);
  }

  with(_change: any): MockUri {
    return this;
  }

  toJSON(): any {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath
    };
  }

  static joinPath(baseUri: MockUri, ...pathSegments: string[]): MockUri {
    const joined = path.join(baseUri.fsPath, ...pathSegments);
    return new MockUri(joined);
  }

  toString(): string {
    return `file://${this.path}`;
  }
}

class MockFileSystem {
  private files: Map<string, Uint8Array> = new Map();

  setFile(filePath: string, text: string) {
    const norm = path.normalize(filePath);
    this.files.set(norm, new TextEncoder().encode(text));
  }

  getFile(filePath: string): string | undefined {
    const norm = path.normalize(filePath);
    const data = this.files.get(norm);
    return data ? new TextDecoder().decode(data) : undefined;
  }

  clear() {
    this.files.clear();
  }

  async readFile(uri: MockUri): Promise<Uint8Array> {
    const norm = path.normalize(uri.fsPath);
    const data = this.files.get(norm);
    if (!data) {
      throw new Error(`File not found: ${uri.fsPath}`);
    }
    return data;
  }

  async writeFile(uri: MockUri, content: Uint8Array): Promise<void> {
    const norm = path.normalize(uri.fsPath);
    this.files.set(norm, content);
  }

  async createDirectory(uri: MockUri): Promise<void> {
    // Virtual directory creation, no-op
  }

  async readDirectory(uri: MockUri): Promise<Array<[string, number]>> {
    const dirNorm = path.normalize(uri.fsPath);
    const results: Array<[string, number]> = [];
    const seen = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(dirNorm) && filePath !== dirNorm) {
        const rel = path.relative(dirNorm, filePath);
        const parts = rel.split(path.sep);
        const topPart = parts[0];
        if (!seen.has(topPart)) {
          seen.add(topPart);
          results.push([topPart, parts.length > 1 ? 2 /* Directory */ : 1 /* File */]);
        }
      }
    }
    return results;
  }

  async delete(uri: MockUri): Promise<void> {
    const norm = path.normalize(uri.fsPath);
    this.files.delete(norm);
  }
}

export const mockFs = new MockFileSystem();

export interface WorkspaceMockState {
  workspaceRoot: string;
  documents: Map<string, MockDocument>;
  diagnostics: Map<string, any[]>;
}

export const mockState: WorkspaceMockState = {
  workspaceRoot: path.normalize('C:/Projects/test-workspace'),
  documents: new Map(),
  diagnostics: new Map()
};

export function resetMockState(workspaceRoot: string = 'C:/Projects/test-workspace') {
  mockState.workspaceRoot = path.normalize(workspaceRoot);
  mockState.documents.clear();
  mockState.diagnostics.clear();
  mockFs.clear();
}

export const vscodeMock = {
  Uri: MockUri,
  Position: MockPosition,
  Range: MockRange,
  WorkspaceEdit: MockWorkspaceEdit,
  DiagnosticSeverity: MockDiagnosticSeverity,
  FileType: {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64
  },
  workspace: {
    get workspaceFolders() {
      return [{
        uri: MockUri.file(mockState.workspaceRoot),
        name: path.basename(mockState.workspaceRoot),
        index: 0
      }];
    },
    asRelativePath(pathOrUri: any): string {
      const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
      return path.relative(mockState.workspaceRoot, p).replace(/\\/g, '/');
    },
    fs: mockFs,
    async openTextDocument(uri: MockUri): Promise<MockDocument> {
      const norm = path.normalize(uri.fsPath);
      let content = mockFs.getFile(norm);
      if (content === undefined) {
        throw new Error(`Cannot open document: ${uri.fsPath}`);
      }

      const doc: MockDocument = {
        uri,
        get content() {
          return mockFs.getFile(norm) || '';
        },
        set content(val: string) {
          mockFs.setFile(norm, val);
        },
        getText(range?: MockRange): string {
          const text = mockFs.getFile(norm) || '';
          if (!range) return text;
          // Substring extraction based on line/char
          const lines = text.split('\n');
          const startLine = lines[range.start.line] || '';
          const endLine = lines[range.end.line] || '';
          if (range.start.line === range.end.line) {
            return startLine.substring(range.start.character, range.end.character);
          }
          // Multi-line
          const parts: string[] = [];
          parts.push(startLine.substring(range.start.character));
          for (let i = range.start.line + 1; i < range.end.line; i++) {
            parts.push(lines[i]);
          }
          parts.push(endLine.substring(0, range.end.character));
          return parts.join('\n');
        },
        positionAt(offset: number): { line: number; character: number } {
          const text = mockFs.getFile(norm) || '';
          const upToOffset = text.slice(0, offset);
          const lines = upToOffset.split('\n');
          return {
            line: lines.length - 1,
            character: lines[lines.length - 1].length
          };
        },
        async save(): Promise<boolean> {
          return true;
        }
      };

      mockState.documents.set(norm, doc);
      return doc;
    },
    async applyEdit(edit: MockWorkspaceEdit): Promise<boolean> {
      for (const op of edit.operations) {
        const norm = path.normalize(op.uri.fsPath);
        let text = mockFs.getFile(norm) || '';
        if (op.type === 'replace' && op.range) {
          // Replace based on line/character position
          const lines = text.split('\n');
          const startLine = lines[op.range.start.line];
          const endLine = lines[op.range.end.line];

          const before = lines.slice(0, op.range.start.line).join('\n') +
            (op.range.start.line > 0 ? '\n' : '') +
            startLine.substring(0, op.range.start.character);

          const after = endLine.substring(op.range.end.character) +
            (op.range.end.line < lines.length - 1 ? '\n' : '') +
            lines.slice(op.range.end.line + 1).join('\n');

          const newText = before + op.newText + after;
          mockFs.setFile(norm, newText);
        }
      }
      return true;
    },
    async findFiles(include: string, exclude?: string, maxResults?: number): Promise<MockUri[]> {
      const results: MockUri[] = [];
      for (const filePath of (mockFs as any).files.keys()) {
        results.push(MockUri.file(filePath));
        if (maxResults && results.length >= maxResults) break;
      }
      return results;
    },
    getConfiguration(section?: string) {
      return {
        get(key: string, defaultValue?: any) {
          return defaultValue;
        }
      };
    }
  },
  languages: {
    getDiagnostics(uri?: MockUri): any[] {
      if (uri) {
        const norm = path.normalize(uri.fsPath);
        return mockState.diagnostics.get(norm) || [];
      }
      const all: any[] = [];
      for (const [key, diags] of mockState.diagnostics.entries()) {
        all.push([MockUri.file(key), diags]);
      }
      return all;
    }
  },
  window: {
    activeTextEditor: undefined as any,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showTextDocument: async (doc: any) => doc,
    showInputBox: async (opts: any) => opts?.value || 'test.txt',
    createOutputChannel: (name: string) => ({
      name,
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),
    terminals: [],
    createTerminal: (name: string) => ({
      name,
      show: () => {},
      sendText: () => {},
      dispose: () => {}
    })
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: (cmd: string, handler: Function) => ({ dispose: () => {} })
  },
  env: {
    appRoot: 'C:/VSCode'
  }
};
