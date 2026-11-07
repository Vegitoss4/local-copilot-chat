import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class WorkspaceManager {
  /**
   * Resolves the target WorkspaceFolder using a strict precedence hierarchy:
   * 1. Explicitly requested preferredUri (e.g. pinned session or active conversation root).
   * 2. Workspace containing the active editor document (if open and within a workspace).
   * 3. Fallback to primary workspace folder (workspaceFolders[0]).
   */
  public static getTargetWorkspaceFolder(preferredUri?: vscode.Uri): vscode.WorkspaceFolder | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    if (folders.length === 1) return folders[0];

    // Precedence 1: Explicitly requested preferred root
    if (preferredUri) {
      const match = vscode.workspace.getWorkspaceFolder(preferredUri);
      if (match) return match;
    }

    // Precedence 2: Active text editor document's workspace folder
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document) {
      const match = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (match) return match;
    }

    // Precedence 3: Fallback to primary folder
    return folders[0];
  }

  /**
   * Returns isolated storage directory URI inside target workspace folder's .vscode/local-copilot/
   */
  public static getStorageUri(folder: vscode.WorkspaceFolder, subPath: string = ''): vscode.Uri {
    const cleanSub = subPath.replace(/^[\\\/]+/, '').replace(/\\/g, '/');
    if (cleanSub) {
      return vscode.Uri.joinPath(folder.uri, '.vscode', 'local-copilot', cleanSub);
    }
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'local-copilot');
  }

  /**
   * Resolves whether a given URI resides within a specific workspace folder boundary.
   */
  public static isUriInFolder(targetUri: vscode.Uri, folder: vscode.WorkspaceFolder): boolean {
    const folderPath = path.normalize(folder.uri.fsPath).toLowerCase();
    const targetPath = path.normalize(targetUri.fsPath).toLowerCase();
    return targetPath.startsWith(folderPath);
  }

  /**
   * Enforces Git hygiene and isolation for extension internal state:
   * 1. Creates .vscode/local-copilot/.gitignore to prevent internal task whiteboards,
   *    diagnostics, and memory cache from dirtying the user's source control repository.
   * 2. Safely handles migrations from legacy unisolated paths.
   */
  public static async ensureStorageHygiene(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const storageDirUri = this.getStorageUri(folder);
      try {
        await vscode.workspace.fs.createDirectory(storageDirUri);
      } catch {}

      const gitignoreUri = vscode.Uri.joinPath(storageDirUri, '.gitignore');
      try {
        await vscode.workspace.fs.stat(gitignoreUri);
      } catch {
        const content = Buffer.from('# Local Copilot Chat internal state isolation\n*\n!.gitignore\n', 'utf8');
        await vscode.workspace.fs.writeFile(gitignoreUri, content);
      }

      // Check root .gitignore if present on disk
      try {
        const rootGitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
        const existingBytes = await vscode.workspace.fs.readFile(rootGitignoreUri);
        const rootContent = Buffer.from(existingBytes).toString('utf8');
        if (!rootContent.includes('.vscode/local-copilot')) {
          const appendEntry = '\n# Local Copilot Chat internal state\n.vscode/local-copilot/\n';
          const newBytes = Buffer.from(rootContent + appendEntry, 'utf8');
          await vscode.workspace.fs.writeFile(rootGitignoreUri, newBytes);
        }
      } catch {
        // Root .gitignore does not exist; storage-level .gitignore provides complete isolation
      }
    } catch (e) {
      console.warn('[WorkspaceManager] Could not enforce storage git hygiene:', e);
    }
  }
}
