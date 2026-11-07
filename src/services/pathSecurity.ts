import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceManager } from './workspaceManager';

export class WorkspaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSecurityError';
  }
}

export interface PathValidationOptions {
  allowNewFile?: boolean;
}

export interface ValidatedPath {
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  canonicalFsPath?: string;
}

export class PathSecurity {
  /**
   * Internal state directory name inside workspace (.vscode/local-copilot)
   */
  public static readonly INTERNAL_STATE_DIR = '.vscode/local-copilot';

  /**
   * Checks whether a path attempts to inspect or mutate extension internal state (.vscode/local-copilot).
   */
  public static isInternalStatePath(targetPath: string): boolean {
    const norm = targetPath.replace(/\\/g, '/').toLowerCase();
    const clean = norm.replace(/^[a-z]:\//i, '/');
    return clean.includes('/.vscode/local-copilot/') ||
           clean.endsWith('/.vscode/local-copilot') ||
           norm.startsWith('.vscode/local-copilot/') ||
           norm === '.vscode/local-copilot';
  }

  /**
   * Identifies sensitive repository files and directories that require explicit developer approval
   * before autonomous modification, even in autonomous mode (Defense-in-Depth against prompt injection).
   */
  public static isSensitiveTarget(targetPath: string): boolean {
    if (!targetPath || typeof targetPath !== 'string') return false;
    const norm = targetPath.replace(/\\/g, '/').toLowerCase();
    const clean = norm.replace(/^[a-z]:\//i, '/');
    const base = path.basename(norm);

    // Git metadata and hooks
    if (clean.includes('/.git/') || clean.startsWith('.git/') || base === '.git' || clean.endsWith('/.git')) {
      return true;
    }

    // CI/CD pipelines & GitHub actions
    if (clean.includes('/.github/') || clean.startsWith('.github/') || clean.includes('/.gitlab/') || clean.startsWith('.gitlab/') || base.startsWith('.gitlab')) {
      return true;
    }

    // Environment and credential files
    if (base.startsWith('.env') || base === '.npmrc' || base === '.pypirc' || clean.includes('/.ssh/')) {
      return true;
    }

    // Build & lifecycle configuration files that execute arbitrary scripts
    if (base === 'package.json' || base === 'tasks.json' || base === 'launch.json') {
      return true;
    }

    // Shell scripts and batch executables
    if (/\.(sh|bat|cmd|ps1|vbs)$/i.test(base)) {
      return true;
    }

    return false;
  }

  /**
   * Validates that targetFolder is a genuine, currently open workspace folder.
   */
  public static resolveWorkspaceFolder(pinned?: vscode.WorkspaceFolder | vscode.Uri): vscode.WorkspaceFolder {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new WorkspaceSecurityError('No open workspace found in VS Code.');
    }

    if (pinned) {
      if ('uri' in pinned && pinned.uri) {
        // WorkspaceFolder object passed: verify it's open
        const match = folders.find(f => f.uri.toString() === pinned.uri.toString());
        if (match) return match;
      } else {
        // Uri passed: find folder containing or matching it
        const match = vscode.workspace.getWorkspaceFolder(pinned as vscode.Uri);
        if (match) return match;
        const exact = folders.find(f => f.uri.toString() === (pinned as vscode.Uri).toString());
        if (exact) return exact;
      }
      throw new WorkspaceSecurityError(`Invalid pinned workspace root: provided root is not an open workspace folder.`);
    }

    // Use WorkspaceManager hierarchy when not explicitly pinned
    const resolved = WorkspaceManager.getTargetWorkspaceFolder();
    if (resolved) return resolved;

    if (folders.length === 1) return folders[0];
    throw new WorkspaceSecurityError('Ambiguous Workspace: Multiple workspace folders open and no target root was specified.');
  }

  /**
   * Validates and resolves a path within an authorized workspace folder.
   * Enforces:
   * 1. Null byte and traversal rejection (..).
   * 2. Absolute path containment within workspace.
   * 3. UNC path rejection.
   * 4. Internal state isolation (.vscode/local-copilot).
   * 5. Physical symlink and directory junction canonicalization (realpath).
   * 6. Nonexistent destination parent-chain validation.
   */
  public static validatePath(
    requestedPath: string,
    pinnedFolder?: vscode.WorkspaceFolder | vscode.Uri,
    options: PathValidationOptions = {}
  ): ValidatedPath {
    if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
      throw new WorkspaceSecurityError('Access Denied: Empty path provided.');
    }

    if (requestedPath.includes('\0')) {
      throw new WorkspaceSecurityError('Access Denied: Path contains illegal null bytes.');
    }

    // Traversal segments before path normalization
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(requestedPath)) {
      throw new WorkspaceSecurityError(`Access Denied: Path "${requestedPath}" contains unauthorized directory traversal sequences.`);
    }

    // Pre-normalization check for internal state access
    if (this.isInternalStatePath(requestedPath)) {
      throw new WorkspaceSecurityError('Access Denied: Cannot access internal extension state.');
    }

    // Reject UNC paths
    if (/^([\\/]{2})/.test(requestedPath)) {
      throw new WorkspaceSecurityError('Access Denied: UNC paths are not permitted.');
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new WorkspaceSecurityError('No open workspace found in VS Code.');
    }

    let targetFolder: vscode.WorkspaceFolder;
    let effectiveRelPath: string;

    // Check if input is a URI with scheme
    const uriSchemeMatch = requestedPath.match(/^([a-zA-Z0-9_\-]+):\/\/(.*)$/);
    if (uriSchemeMatch) {
      const parsedUri = vscode.Uri.parse(requestedPath);
      const matchingFolder = folders.find(
        f => f.uri.scheme === parsedUri.scheme && f.uri.authority === parsedUri.authority
      );

      if (!matchingFolder) {
        throw new WorkspaceSecurityError('Access Denied: Path resolves outside permitted workspace schemes/authorities.');
      }

      if (parsedUri.scheme !== 'file') {
        const folderPathSegments = matchingFolder.uri.path.split('/').filter(Boolean);
        const targetPathSegments = parsedUri.path.split('/').filter(Boolean);

        if (targetPathSegments.length < folderPathSegments.length) {
          throw new WorkspaceSecurityError('Access Denied: Path resolves outside workspace folder.');
        }

        for (let i = 0; i < folderPathSegments.length; i++) {
          if (targetPathSegments[i] !== folderPathSegments[i]) {
            throw new WorkspaceSecurityError('Access Denied: Path resolves outside workspace folder.');
          }
        }

        return { uri: parsedUri, folder: matchingFolder };
      }

      requestedPath = parsedUri.fsPath;
    }

    const isDriveAbs = /^[a-zA-Z]:[\\/]/.test(requestedPath);
    const isPosixAbs = process.platform !== 'win32' && path.isAbsolute(requestedPath) && (folders.some(f => requestedPath.startsWith(f.uri.fsPath)) || /^\/(etc|var|usr|root|bin|home|opt)/.test(requestedPath));
    const isAbs = isDriveAbs || isPosixAbs;

    if (isAbs) {
      const normAbs = path.normalize(requestedPath);
      const isWin = process.platform === 'win32';
      const absForComp = isWin ? normAbs.toLowerCase() : normAbs;

      if (pinnedFolder) {
        targetFolder = this.resolveWorkspaceFolder(pinnedFolder);
        const folderNorm = path.normalize(targetFolder.uri.fsPath);
        const folderForComp = isWin ? folderNorm.toLowerCase() : folderNorm;
        const rel = path.relative(folderForComp, absForComp);
        if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '..') {
          throw new WorkspaceSecurityError(`Access Denied: Path "${requestedPath}" resolves outside the authorized workspace.`);
        }
        effectiveRelPath = rel;
      } else {
        const matching = folders
          .filter(f => f.uri.scheme === 'file')
          .map(f => {
            const folderNorm = path.normalize(f.uri.fsPath);
            const folderForComp = isWin ? folderNorm.toLowerCase() : folderNorm;
            const rel = path.relative(folderForComp, absForComp);
            const isContained = !rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '..';
            return { folder: f, folderNorm, isContained, length: folderNorm.length };
          })
          .filter(m => m.isContained);

        if (matching.length === 0) {
          throw new WorkspaceSecurityError(`Access Denied: Path "${requestedPath}" resolves outside the permitted workspace.`);
        }

        matching.sort((a, b) => b.length - a.length);
        targetFolder = matching[0].folder;
        effectiveRelPath = path.relative(matching[0].folderNorm, normAbs);
      }
    } else {
      // Relative path handling
      const cleanRel = requestedPath.replace(/^[\\\/]+/, '');

      if (pinnedFolder) {
        targetFolder = this.resolveWorkspaceFolder(pinnedFolder);
        // If relative path starts with the folder name, strip it
        const firstSegment = cleanRel.split(/[\\\/]/)[0];
        if (firstSegment === targetFolder.name) {
          effectiveRelPath = cleanRel.slice(firstSegment.length).replace(/^[\\\/]+/, '');
        } else {
          effectiveRelPath = cleanRel;
        }
      } else if (folders.length > 1) {
        const firstSegment = cleanRel.split(/[\\\/]/)[0];
        const matchingByName = folders.filter(f => f.name === firstSegment);

        if (matchingByName.length === 1) {
          targetFolder = matchingByName[0];
          effectiveRelPath = cleanRel.slice(firstSegment.length).replace(/^[\\\/]+/, '');
        } else if (matchingByName.length > 1) {
          throw new WorkspaceSecurityError(`Ambiguous Workspace Folder: Multiple workspace folders named "${firstSegment}".`);
        } else {
          // If active editor matches an open folder, resolve against it
          const activeEditor = vscode.window.activeTextEditor;
          const activeFolder = activeEditor?.document ? vscode.workspace.getWorkspaceFolder(activeEditor.document.uri) : undefined;
          if (activeFolder) {
            targetFolder = activeFolder;
            effectiveRelPath = cleanRel;
          } else {
            throw new WorkspaceSecurityError(`Ambiguous Workspace Folder: Path "${requestedPath}" does not specify an active workspace folder.`);
          }
        }
      } else {
        targetFolder = folders[0];
        effectiveRelPath = cleanRel;
      }
    }

    if (targetFolder.uri.scheme !== 'file') {
      const targetUri = vscode.Uri.joinPath(targetFolder.uri, effectiveRelPath.replace(/\\/g, '/'));
      return { uri: targetUri, folder: targetFolder };
    }

    const isWin = process.platform === 'win32';
    const folderRootNorm = path.normalize(targetFolder.uri.fsPath);
    const candidateFsPath = path.resolve(folderRootNorm, effectiveRelPath);
    let resolvedCanonicalFsPath = candidateFsPath;

    const rootForComp = isWin ? folderRootNorm.toLowerCase() : folderRootNorm;
    const candidateForComp = isWin ? candidateFsPath.toLowerCase() : candidateFsPath;
    const lexicalRel = path.relative(rootForComp, candidateForComp);

    if (lexicalRel.startsWith('..') || lexicalRel === '..' || path.isAbsolute(lexicalRel)) {
      throw new WorkspaceSecurityError(`Access Denied: Path "${requestedPath}" resolves outside the permitted workspace.`);
    }

    // Physical filesystem symlink & junction containment checks
    if (fs.existsSync(folderRootNorm)) {
      try {
        if (fs.existsSync(candidateFsPath)) {
          const canonicalTarget = fs.realpathSync.native ? fs.realpathSync.native(candidateFsPath) : fs.realpathSync(candidateFsPath);
          resolvedCanonicalFsPath = canonicalTarget;
          const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(folderRootNorm) : fs.realpathSync(folderRootNorm);

          const canTargetComp = isWin ? canonicalTarget.toLowerCase() : canonicalTarget;
          const canRootComp = isWin ? canonicalRoot.toLowerCase() : canonicalRoot;

          const canRel = path.relative(canRootComp, canTargetComp);
          if (canRel.startsWith('..') || canRel === '..' || path.isAbsolute(canRel)) {
            throw new WorkspaceSecurityError(`Access Denied: Path "${requestedPath}" resolves outside the permitted workspace via symbolic link or junction.`);
          }

          if (this.isInternalStatePath(canonicalTarget)) {
            throw new WorkspaceSecurityError('Access Denied: Cannot access internal extension state.');
          }
        } else {
          if (!options.allowNewFile) {
            throw new WorkspaceSecurityError(`Access Denied: File not found "${requestedPath}".`);
          }

          let ancestor = path.dirname(candidateFsPath);
          while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
            ancestor = path.dirname(ancestor);
          }

          if (fs.existsSync(ancestor)) {
            const canonicalAncestor = fs.realpathSync.native ? fs.realpathSync.native(ancestor) : fs.realpathSync(ancestor);
            const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(folderRootNorm) : fs.realpathSync(folderRootNorm);

            const canAncComp = isWin ? canonicalAncestor.toLowerCase() : canonicalAncestor;
            const canRootComp = isWin ? canonicalRoot.toLowerCase() : canonicalRoot;

            const ancRel = path.relative(canRootComp, canAncComp);
            if (ancRel.startsWith('..') || ancRel === '..' || path.isAbsolute(ancRel)) {
              throw new WorkspaceSecurityError(`Access Denied: Parent directory of "${requestedPath}" resolves outside the permitted workspace.`);
            }

            if (this.isInternalStatePath(canonicalAncestor)) {
              throw new WorkspaceSecurityError('Access Denied: Cannot access internal extension state.');
            }
          } else {
            throw new WorkspaceSecurityError(`Access Denied: Parent directory of "${requestedPath}" does not exist.`);
          }
        }
      } catch (e: any) {
        if (e instanceof WorkspaceSecurityError) {
          throw e;
        }
        throw new WorkspaceSecurityError(`Access Denied: Canonicalization failed for "${requestedPath}".`);
      }
    }

    const fileUri = vscode.Uri.file(candidateFsPath);
    return { uri: fileUri, folder: targetFolder, canonicalFsPath: resolvedCanonicalFsPath };
  }
}
