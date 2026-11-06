import * as vscode from 'vscode';
import * as path from 'path';

export interface WorkspaceSummary {
  projectName: string;
  rootPath: string;
  fileTree: string[];
  keyFiles: Array<{ name: string; content: string }>;
  activeFile?: { path: string; content: string };
}

export class WorkspaceContextService {
  private static readonly IGNORED_DIRS = new Set([
    'node_modules',
    '.git',
    '.vs',
    '.vscode',
    'bin',
    'obj',
    'dist',
    'build',
    'out',
    '.gemini',
    '.idea'
  ]);

  private static readonly KEY_MANIFESTS = [
    'README.md',
    'package.json',
    'TaskManager.slnx',
    'Cargo.toml',
    'pom.xml',
    'requirements.txt',
    'pyproject.toml',
    'docker-compose.yml',
    'Dockerfile'
  ];

  public static async getActiveFileContext(): Promise<{ path: string; content: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;

    const doc = editor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const content = doc.getText();
    
    // Cap active file content to ~6000 chars to prevent overflowing context
    const truncatedContent = content.length > 6000 ? content.slice(0, 6000) + '\n...[truncated]' : content;

    return {
      path: relPath,
      content: truncatedContent
    };
  }

  public static async getWorkspaceSummary(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      const activeFile = await this.getActiveFileContext();
      if (activeFile) {
        return `Current Active File: ${activeFile.path}\n\`\`\`\n${activeFile.content}\n\`\`\``;
      }
      return 'No workspace folder currently open.';
    }

    const rootFolder = folders[0];
    const projectName = rootFolder.name;
    const rootUri = rootFolder.uri;

    // Scan top 2 levels of files and folders
    const structureList: string[] = [];
    try {
      await this.scanDir(rootUri, '', 0, 2, structureList);
    } catch {
      // ignore
    }

    // Inspect key manifests
    const keyFilesSummary: string[] = [];
    for (const manifestName of this.KEY_MANIFESTS) {
      try {
        const fileUri = vscode.Uri.joinPath(rootUri, manifestName);
        const fileData = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder('utf-8').decode(fileData);
        const trimmed = text.length > 2000 ? text.slice(0, 2000) + '\n...(truncated)' : text;
        keyFilesSummary.push(`--- File: ${manifestName} ---\n${trimmed}\n`);
      } catch {
        // File does not exist, continue
      }
    }

    // Active file
    const activeFile = await this.getActiveFileContext();

    let summary = `=== WORKSPACE CONTEXT: "${projectName}" ===\n`;
    summary += `Project Directory Structure:\n${structureList.slice(0, 40).join('\n')}\n\n`;

    if (keyFilesSummary.length > 0) {
      summary += `Key Project Files:\n${keyFilesSummary.join('\n')}\n`;
    }

    if (activeFile) {
      summary += `Currently Active Editor File: ${activeFile.path}\n\`\`\`\n${activeFile.content}\n\`\`\`\n`;
    }

    summary += `=== END WORKSPACE CONTEXT ===\n`;
    return summary;
  }

  private static async scanDir(
    dirUri: vscode.Uri,
    relPrefix: string,
    depth: number,
    maxDepth: number,
    outList: string[]
  ): Promise<void> {
    if (depth > maxDepth || outList.length > 40) return;

    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name, type] of entries) {
      if (this.IGNORED_DIRS.has(name) || name.startsWith('.')) continue;

      const displayPath = relPrefix ? `${relPrefix}/${name}` : name;
      if (type === vscode.FileType.Directory) {
        outList.push(`📁 ${displayPath}/`);
        await this.scanDir(vscode.Uri.joinPath(dirUri, name), displayPath, depth + 1, maxDepth, outList);
      } else if (type === vscode.FileType.File) {
        outList.push(`📄 ${displayPath}`);
      }
    }
  }
}
