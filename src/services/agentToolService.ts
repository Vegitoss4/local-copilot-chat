import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryService } from './memoryService';
import { OllamaService } from './ollamaService';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  success: boolean;
  output: string;
  diagnostics?: string;
}

export class AgentToolService {
  private static cachedRgPath: string | null = null;

  /**
   * JSON Schemas for Ollama tool calling
   */
  public static readonly TOOL_DEFINITIONS: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'view_file_range',
        description: 'Read a specific line range from a workspace file with prepended line numbers (e.g. L12: content). Conserves context window.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path of the file from workspace root (e.g. Backend.Api/Program.cs)'
            },
            startLine: {
              type: 'integer',
              description: 'First line to read (1-based, inclusive)'
            },
            endLine: {
              type: 'integer',
              description: 'Last line to read (1-based, inclusive)'
            }
          },
          required: ['filePath', 'startLine', 'endLine']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'str_replace',
        description: 'Surgically replace an exact unique block of code (oldStr) with new code (newStr) in a file. Does not rewrite whole file.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the workspace file to edit'
            },
            oldStr: {
              type: 'string',
              description: 'The exact string block currently in the file. Must occur exactly once for safety.'
            },
            newStr: {
              type: 'string',
              description: 'The replacement string block'
            }
          },
          required: ['filePath', 'oldStr', 'newStr']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        description: 'Create a new file with specified content. Creates parent directories automatically.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path of the new file (e.g. Backend.Api/Models/TaskItem.cs)'
            },
            content: {
              type: 'string',
              description: 'Full initial text content of the new file'
            }
          },
          required: ['filePath', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply a unified diff patch to a workspace file.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the workspace file'
            },
            patchContent: {
              type: 'string',
              description: 'Unified diff patch content'
            }
          },
          required: ['filePath', 'patchContent']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: 'Execute a shell command inside the workspace root (e.g. dotnet build, npm test, git status). Returns stdout, stderr, and exit code.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command line string to run'
            }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_diagnostics',
        description: 'Retrieve active language server (LSP) compiler errors and lint warnings for a file or the entire workspace.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Optional relative path to inspect. If omitted, returns diagnostics across workspace.'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_workspace',
        description: 'Search across workspace files for symbols, class names, functions, or text patterns using high-performance search.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text string or regex pattern to search for'
            },
            maxResults: {
              type: 'integer',
              description: 'Maximum number of results to return (default 25)'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List directories and files in a workspace folder path.',
        parameters: {
          type: 'object',
          properties: {
            dirPath: {
              type: 'string',
              description: 'Relative directory path (e.g. "Backend.Api" or "" for root)'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: 'Ask the user a clarifying question when requirements are ambiguous, when architectural decisions are needed, or when you need human guidance. Pauses agent execution until the user answers.',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The specific question to ask the user'
            }
          },
          required: ['question']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'semantic_search',
        description: 'Semantically search indexed code chunks, architectural decisions, past solutions, or user preferences using local vector embeddings. Returns top matches with similarity scores.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language search query or concept to look up in vector memory'
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of relevant chunks to retrieve (default: 3)'
            },
            category: {
              type: 'string',
              enum: ['all', 'code', 'decision', 'architecture', 'preference', 'plan'],
              description: 'Filter search to a specific memory category'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'store_memory',
        description: 'Commit an architectural decision, user preference, technical pattern, or solution note into persistent long-term vector memory.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The architectural decision, rule, preference, or technical insight to remember'
            },
            category: {
              type: 'string',
              enum: ['decision', 'architecture', 'preference', 'plan', 'code'],
              description: 'Category of this memory entry'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional semantic tags (e.g. ["angular", "signals", "csharp"])'
            }
          },
          required: ['content', 'category']
        }
      }
    }
  ];

  /**
   * Identifies if a tool requires human-in-the-loop confirmation in non-autonomous mode
   */
  public static isDestructiveTool(toolName: string): boolean {
    const destructive = ['str_replace', 'create_file', 'apply_patch', 'execute_command'];
    return destructive.includes(toolName);
  }

  /**
   * Resolves a workspace relative path to a URI
   */
  public static getFileUri(relativePath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No open workspace found in VS Code.');
    }
    const cleanRel = relativePath.replace(/^[\\\/]+/, '');
    return vscode.Uri.joinPath(folders[0].uri, cleanRel);
  }

  /**
   * Tool: view_file_range
   */
  public static async viewFileRange(filePath: string, startLine: number, endLine: number): Promise<string> {
    try {
      const fileUri = this.getFileUri(filePath);
      const data = await vscode.workspace.fs.readFile(fileUri);
      const text = new TextDecoder('utf-8').decode(data);
      const lines = text.split(/\r?\n/);

      const totalLines = lines.length;
      const start = Math.max(1, startLine);
      const end = Math.min(totalLines, Math.max(start, endLine));

      const slice = lines.slice(start - 1, end);
      const formatted = slice.map((line, idx) => `L${start + idx}: ${line}`).join('\n');

      return `File: ${filePath} (Lines ${start}-${end} of ${totalLines}):\n${formatted}`;
    } catch (err: any) {
      return `Error viewing file range: ${err.message}`;
    }
  }

  /**
   * Tool: str_replace (Surgical replacement with uniqueness validation)
   */
  public static async strReplace(filePath: string, oldStr: string, newStr: string): Promise<{ success: boolean; output: string; diagnostics?: string }> {
    try {
      const fileUri = this.getFileUri(filePath);
      const document = await vscode.workspace.openTextDocument(fileUri);
      const fullText = document.getText();

      // Normalize line endings for comparison
      const normalizedOld = oldStr.replace(/\r\n/g, '\n');
      const normalizedDoc = fullText.replace(/\r\n/g, '\n');

      const firstIndex = normalizedDoc.indexOf(normalizedOld);
      if (firstIndex === -1) {
        // Find nearest matching lines for helpful error
        const oldLines = normalizedOld.split('\n');
        const firstLine = oldLines[0]?.trim();
        let hint = '';
        if (firstLine) {
          const docLines = normalizedDoc.split('\n');
          const candidateLines: number[] = [];
          docLines.forEach((l, i) => {
            if (l.includes(firstLine.slice(0, 30))) candidateLines.push(i + 1);
          });
          if (candidateLines.length > 0) {
            hint = ` Target snippet not found. First line might match near line(s): ${candidateLines.join(', ')}.`;
          }
        }
        return {
          success: false,
          output: `Replacement failed: 'oldStr' not found in ${filePath}.${hint} Please use view_file_range to verify the current lines.`
        };
      }

      // Check uniqueness
      const secondIndex = normalizedDoc.indexOf(normalizedOld, firstIndex + 1);
      if (secondIndex !== -1) {
        // Collect line numbers of occurrences
        const occurrences: number[] = [];
        let cur = firstIndex;
        while (cur !== -1) {
          const lineNum = normalizedDoc.slice(0, cur).split('\n').length;
          occurrences.push(lineNum);
          cur = normalizedDoc.indexOf(normalizedOld, cur + 1);
        }
        return {
          success: false,
          output: `Replacement failed: 'oldStr' occurs ${occurrences.length} times in ${filePath} (starting around lines: ${occurrences.join(', ')}). Please expand oldStr to include unique surrounding lines.`
        };
      }

      // Determine VS Code document range
      const startPos = document.positionAt(firstIndex);
      const endPos = document.positionAt(firstIndex + normalizedOld.length);
      const range = new vscode.Range(startPos, endPos);

      const edit = new vscode.WorkspaceEdit();
      edit.replace(fileUri, range, newStr);

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return { success: false, output: `VS Code WorkspaceEdit failed to apply to ${filePath}.` };
      }

      await document.save();

      // Brief delay to allow Language Server to re-diagnose file
      await new Promise(r => setTimeout(r, 400));
      const diagnostics = this.getFileDiagnosticsString(fileUri);

      return {
        success: true,
        output: `Successfully replaced code in ${filePath} at lines ${startPos.line + 1}-${endPos.line + 1}.`,
        diagnostics: diagnostics || undefined
      };
    } catch (err: any) {
      return { success: false, output: `Error in str_replace: ${err.message}` };
    }
  }

  /**
   * Tool: create_file
   */
  public static async createFile(filePath: string, content: string): Promise<{ success: boolean; output: string; diagnostics?: string }> {
    try {
      const fileUri = this.getFileUri(filePath);
      const data = new TextEncoder().encode(content);
      await vscode.workspace.fs.writeFile(fileUri, data);

      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });

      // Check diagnostics
      await new Promise(r => setTimeout(r, 400));
      const diagnostics = this.getFileDiagnosticsString(fileUri);

      return {
        success: true,
        output: `Successfully created file ${filePath} (${content.length} bytes).`,
        diagnostics: diagnostics || undefined
      };
    } catch (err: any) {
      return { success: false, output: `Failed to create file ${filePath}: ${err.message}` };
    }
  }

  /**
   * Tool: apply_patch
   */
  public static async applyPatch(filePath: string, patchContent: string): Promise<{ success: boolean; output: string }> {
    try {
      const fileUri = this.getFileUri(filePath);
      const document = await vscode.workspace.openTextDocument(fileUri);
      let content = document.getText();

      const lines = patchContent.split(/\r?\n/);
      let searchBlock: string[] = [];
      let replaceBlock: string[] = [];
      let inHunk = false;

      for (const line of lines) {
        if (line.startsWith('@@')) {
          inHunk = true;
          continue;
        }
        if (!inHunk) continue;

        if (line.startsWith('-')) {
          searchBlock.push(line.slice(1));
        } else if (line.startsWith('+')) {
          replaceBlock.push(line.slice(1));
        } else if (line.startsWith(' ')) {
          searchBlock.push(line.slice(1));
          replaceBlock.push(line.slice(1));
        }
      }

      if (searchBlock.length === 0 && replaceBlock.length === 0) {
        return { success: false, output: 'Invalid patch format: no changes detected.' };
      }

      const searchStr = searchBlock.join('\n');
      const replaceStr = replaceBlock.join('\n');

      const res = await this.strReplace(filePath, searchStr, replaceStr);
      return { success: res.success, output: res.output };
    } catch (err: any) {
      return { success: false, output: `Failed to apply patch to ${filePath}: ${err.message}` };
    }
  }

  /**
   * Tool: execute_command
   */
  public static async executeCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();

    return new Promise((resolve) => {
      exec(command, { cwd, maxBuffer: 1024 * 1024 * 5, timeout: 60000 }, (error, stdout, stderr) => {
        resolve({
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim(),
          exitCode: error ? (error.code ?? 1) : 0
        });
      });
    });
  }

  /**
   * Tool: get_diagnostics (Queries Language Server Protocol)
   */
  public static getDiagnostics(filePath?: string): string {
    if (filePath) {
      try {
        const fileUri = this.getFileUri(filePath);
        return this.getFileDiagnosticsString(fileUri) || `No compiler or lint diagnostics for ${filePath}.`;
      } catch (e: any) {
        return `Error getting diagnostics: ${e.message}`;
      }
    }

    const allDiags = vscode.languages.getDiagnostics();
    const reports: string[] = [];

    for (const [uri, diags] of allDiags) {
      if (diags.length === 0) continue;
      const rel = vscode.workspace.asRelativePath(uri);
      const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

      if (errors.length > 0 || warnings.length > 0) {
        reports.push(`--- ${rel} ---`);
        for (const d of diags) {
          const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
          const line = d.range.start.line + 1;
          const col = d.range.start.character + 1;
          reports.push(`[${sev}] Line ${line}:${col} - ${d.message} (${d.source || 'LSP'}${d.code ? ' ' + d.code : ''})`);
        }
      }
    }

    return reports.length > 0 ? reports.join('\n') : 'No diagnostics or errors detected across workspace.';
  }

  /**
   * Helper: gets clean string of diagnostics for a file
   */
  public static getFileDiagnosticsString(fileUri: vscode.Uri): string | null {
    const diags = vscode.languages.getDiagnostics(fileUri);
    const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    if (errors.length === 0) return null;

    const rel = vscode.workspace.asRelativePath(fileUri);
    const list = errors.map(e => `[LSP Error] ${rel}:${e.range.start.line + 1}:${e.range.start.character + 1} - ${e.message}`);
    return list.join('\n');
  }

  /**
   * Tool: search_workspace (Uses VS Code bundled ripgrep binary)
   */
  public static async searchWorkspace(query: string, maxResults: number = 25): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return 'No open workspace.';
    const cwd = folders[0].uri.fsPath;

    const rgPath = this.getRipgrepPath();
    if (rgPath) {
      try {
        const results = await this.runRipgrep(rgPath, query, cwd, maxResults);
        if (results.length > 0) {
          return results.slice(0, maxResults).join('\n');
        }
      } catch (e) {
        // Fall back to workspace search
      }
    }

    // Fallback: vscode.workspace.findFiles
    return this.searchWorkspaceFallback(query, maxResults);
  }

  /**
   * Tool: list_dir
   */
  public static async listDir(dirPath: string = ''): Promise<string> {
    try {
      const targetUri = dirPath ? this.getFileUri(dirPath) : vscode.workspace.workspaceFolders![0].uri;
      const entries = await vscode.workspace.fs.readDirectory(targetUri);
      const lines = entries.map(([name, type]) => {
        const typeStr = type === vscode.FileType.Directory ? '[DIR]' : '[FILE]';
        return `${typeStr} ${name}`;
      });
      return lines.join('\n') || '(empty directory)';
    } catch (err: any) {
      return `Error listing directory ${dirPath}: ${err.message}`;
    }
  }

  /**
   * Fast Ripgrep resolution from VS Code environment
   */
  private static getRipgrepPath(): string | null {
    if (this.cachedRgPath) return this.cachedRgPath;

    const appRoot = vscode.env.appRoot;
    const candidates = [
      path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', process.platform === 'win32' ? 'win32-x64' : '', process.platform === 'win32' ? 'rg.exe' : 'rg'),
      path.join(appRoot, 'node_modules.asar.unpacked', '@github', 'copilot-sdk-win32-x64', 'ripgrep', 'bin', 'win32-x64', 'rg.exe'),
      path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'),
      path.join(appRoot, '..', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.cachedRgPath = c;
        return c;
      }
    }

    return null;
  }

  private static runRipgrep(rgPath: string, query: string, cwd: string, maxResults: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = [
        '-i',
        '--line-number',
        '--column',
        '--max-count', String(maxResults),
        '--glob', '!**/node_modules/**',
        '--glob', '!**/.git/**',
        '--glob', '!**/bin/**',
        '--glob', '!**/obj/**',
        '--glob', '!**/dist/**',
        query,
        '.'
      ];

      execFile(rgPath, args, { cwd, maxBuffer: 1024 * 1024 * 2 }, (error, stdout) => {
        if (error && error.code !== 1) { // code 1 means no matches
          return reject(error);
        }
        const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
        resolve(lines);
      });
    });
  }

  private static async searchWorkspaceFallback(query: string, maxResults: number): Promise<string> {
    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/dist/**}', 30);
    const results: string[] = [];

    for (const file of files) {
      try {
        const data = await vscode.workspace.fs.readFile(file);
        const text = new TextDecoder('utf-8').decode(data);
        const lines = text.split('\n');

        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push(`${vscode.workspace.asRelativePath(file)}:${idx + 1}: ${line.trim()}`);
          }
        });

        if (results.length >= maxResults) break;
      } catch {
        // Skip binary
      }
    }

    return results.length > 0 ? results.slice(0, maxResults).join('\n') : `No matches found for "${query}" in workspace.`;
  }

  /**
   * Full Build Checker (.NET / Node)
   */
  public static async checkBuild(): Promise<{ success: boolean; output: string }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { success: false, output: 'No workspace folder open.' };
    }

    const dotnetFiles = await vscode.workspace.findFiles('**/*.{sln,slnx,csproj}', '{**/node_modules/**,**/bin/**,**/obj/**}', 1);
    if (dotnetFiles.length > 0) {
      const result = await this.executeCommand('dotnet build');
      const cleanOut = (result.stdout + '\n' + result.stderr).trim();
      return {
        success: result.exitCode === 0,
        output: cleanOut.slice(-3000)
      };
    }

    const packageFiles = await vscode.workspace.findFiles('package.json', '{**/node_modules/**}', 1);
    if (packageFiles.length > 0) {
      const result = await this.executeCommand('npm run build');
      const cleanOut = (result.stdout + '\n' + result.stderr).trim();
      return {
        success: result.exitCode === 0,
        output: cleanOut.slice(-3000)
      };
    }

    return { success: false, output: 'No .NET or Node project detected.' };
  }

  /**
   * Gets Git Diff summary
   */
  public static async getGitDiff(): Promise<string> {
    const result = await this.executeCommand('git diff --stat && git status --short');
    if (result.exitCode !== 0) {
      return 'Git is not initialized or failed to run.';
    }
    return result.stdout.trim() || 'Working tree clean, no pending changes.';
  }

  /**
   * Tool: semantic_search
   */
  public static async semanticSearch(
    query: string,
    limit: number = 3,
    category?: string,
    ollamaService?: OllamaService
  ): Promise<string> {
    try {
      const memory = MemoryService.getInstance(ollamaService || new OllamaService());
      const results = await memory.semanticSearch(query, limit, category);

      if (results.length === 0) {
        return `No matching memory or code chunks found for "${query}".`;
      }

      const formatted = results.map((r, i) => {
        const meta = r.chunk.metadata;
        const score = (r.similarity * 100).toFixed(1);
        const origin = meta.filePath ? `File: ${meta.filePath}` : `Category: [${meta.category}] (${meta.agentOrigin})`;
        return `### Result ${i + 1} (Relevance: ${score}% | ${origin}):\n${r.chunk.text}`;
      }).join('\n\n---\n\n');

      return formatted;
    } catch (err: any) {
      return `Error in semantic_search: ${err.message}`;
    }
  }

  /**
   * Tool: store_memory
   */
  public static async storeMemory(
    content: string,
    category: 'decision' | 'architecture' | 'preference' | 'plan' | 'code',
    tags?: string[],
    ollamaService?: OllamaService
  ): Promise<{ success: boolean; output: string }> {
    try {
      const memory = MemoryService.getInstance(ollamaService || new OllamaService());
      const chunk = await memory.storeMemoryItem(content, {
        category,
        tags: tags || [],
        agentOrigin: 'orchestrator'
      });

      return {
        success: true,
        output: `Successfully stored memory in .vscode/local-copilot/memory.json (ID: ${chunk.id}, Category: ${category}). Total indexed items: ${memory.getMemoryCount()}.`
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Error in store_memory: ${err.message}`
      };
    }
  }
}
