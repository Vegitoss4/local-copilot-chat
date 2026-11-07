import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class ExecutableResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutableResolutionError';
  }
}

export interface ResolvedCommand {
  executable: string;
  args: string[];
}

export class ExecutableResolver {
  private static readonly PROHIBITED_EXTENSIONS = new Set([
    '.bat', '.cmd', '.ps1', '.vbs', '.wsf', '.sh', '.bash'
  ]);

  /**
   * Resolves a command executable to an absolute path on host.
   */
  public static resolve(
    rawExecutable: string,
    platform: string = process.platform,
    pathEnv?: string
  ): string {
    const res = this.resolveCommand(rawExecutable, [], platform, pathEnv);
    return res.executable;
  }

  /**
   * Platform-aware command and arguments resolution.
   * Enforces:
   * 1. Rejection of direct script file execution (.bat, .cmd, .ps1, etc.)
   * 2. Rejection of workspace binary hijacking (binary cannot originate inside workspace folders)
   * 3. Rejection of POSIX shell scripts as Windows executables
   * 4. Safe Node.js tooling invocation on Windows (node.exe invoking npm-cli.js / npx-cli.js)
   * 5. Safe system PATH resolution
   */
  public static resolveCommand(
    rawExecutable: string,
    args: string[] = [],
    platform: string = process.platform,
    pathEnv?: string
  ): ResolvedCommand {
    if (!rawExecutable || !rawExecutable.trim()) {
      throw new ExecutableResolutionError('Executable name cannot be empty.');
    }

    const trimmed = rawExecutable.trim();
    const ext = path.extname(trimmed).toLowerCase();

    if (this.PROHIBITED_EXTENSIONS.has(ext)) {
      throw new ExecutableResolutionError(
        `Direct execution of script files (${ext}) is prohibited by security policy.`
      );
    }

    const isWindows = platform === 'win32';
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const workspacePaths = workspaceFolders.map((f) => path.normalize(f.uri.fsPath).toLowerCase());

    // Case 1: Absolute path provided
    if (path.isAbsolute(trimmed)) {
      const normalizedPath = path.normalize(trimmed);
      const lowerNorm = normalizedPath.toLowerCase();

      // Check if binary resides in workspace folder (hijack defense)
      for (const ws of workspacePaths) {
        if (lowerNorm.startsWith(ws + path.sep) || lowerNorm === ws) {
          throw new ExecutableResolutionError(
            `Access Denied: Executable resides within the workspace boundary ('${normalizedPath}'). Workspace-local binary execution is prohibited to prevent binary hijacking.`
          );
        }
      }

      if (!fs.existsSync(normalizedPath)) {
        throw new ExecutableResolutionError(`Executable not found at specified path: '${normalizedPath}'.`);
      }

      if (isWindows && !path.extname(normalizedPath)) {
        throw new ExecutableResolutionError(
          `Cannot execute extensionless POSIX script '${normalizedPath}' on Windows without a shell.`
        );
      }

      return { executable: normalizedPath, args: [...args] };
    }

    const baseName = path.basename(trimmed).toLowerCase().replace(/\.exe$/i, '');

    // Case 2: Windows Node.js tooling (npm, npx) resolution
    if (isWindows && (baseName === 'npm' || baseName === 'npx')) {
      const nodeRes = this.findNodeAndNpmCli(baseName as 'npm' | 'npx', workspacePaths, pathEnv);
      if (nodeRes) {
        return {
          executable: nodeRes.nodePath,
          args: [nodeRes.cliPath, ...args]
        };
      }

      throw new ExecutableResolutionError(
        `Node.js tool '${trimmed}' could not be resolved to a valid Node.js launcher or trusted binary on Windows without invoking a shell.`
      );
    }

    // Case 3: Bare name or relative path - resolve through system PATH (excluding workspace paths)
    const rawPathEnv = pathEnv !== undefined ? pathEnv : (process.env.PATH || process.env.Path || '');
    const pathDirs = rawPathEnv.split(path.delimiter).filter(Boolean);

    // On Windows, safe executable extensions: ONLY .exe if no extension specified.
    // Never select '' on Windows (which would match extensionless POSIX shell scripts)
    const candidateExtensions = isWindows
      ? ext ? [''] : ['.exe']
      : [''];

    for (const dir of pathDirs) {
      const normalizedDir = path.normalize(dir);
      const lowerDir = normalizedDir.toLowerCase();

      // Skip any PATH entry that points inside a workspace folder
      let isInWorkspace = false;
      for (const ws of workspacePaths) {
        if (lowerDir.startsWith(ws + path.sep) || lowerDir === ws) {
          isInWorkspace = true;
          break;
        }
      }
      if (isInWorkspace) {
        continue;
      }

      for (const candExt of candidateExtensions) {
        if (candExt && this.PROHIBITED_EXTENSIONS.has(candExt.toLowerCase())) {
          continue;
        }

        const candidateFile = path.join(normalizedDir, trimmed + candExt);
        try {
          if (fs.existsSync(candidateFile)) {
            const stat = fs.statSync(candidateFile);
            if (stat.isFile()) {
              return { executable: candidateFile, args: [...args] };
            }
          }
        } catch {}
      }
    }

    // If not found in PATH, throw ExecutableResolutionError (fail closed)
    throw new ExecutableResolutionError(`Executable '${trimmed}' not found in system PATH.`);
  }

  private static findNodeAndNpmCli(
    tool: 'npm' | 'npx',
    workspacePaths: string[],
    pathEnv?: string
  ): { nodePath: string; cliPath: string } | null {
    const rawPathEnv = pathEnv !== undefined ? pathEnv : (process.env.PATH || process.env.Path || '');
    const pathDirs = rawPathEnv.split(path.delimiter).filter(Boolean);

    // Expand search directories with standard installation roots as untrusted path hints ONLY when no custom pathEnv is specified
    const candidateDirs = [...pathDirs];
    if (pathEnv === undefined) {
      if (process.env['ProgramFiles']) {
        candidateDirs.push(path.join(process.env['ProgramFiles'], 'nodejs'));
      }
      if (process.env['ProgramFiles(x86)']) {
        candidateDirs.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs'));
      }
      if (process.env['NVM_SYMLINK']) {
        candidateDirs.push(process.env['NVM_SYMLINK']);
      }
      if (process.env['NVM_HOME']) {
        candidateDirs.push(process.env['NVM_HOME']);
      }
      if (process.env['VOLTA_HOME']) {
        candidateDirs.push(path.join(process.env['VOLTA_HOME'], 'bin'));
      } else if (process.env['LOCALAPPDATA']) {
        candidateDirs.push(path.join(process.env['LOCALAPPDATA'], 'Volta', 'bin'));
      }
      if (process.env['FNM_DIR']) {
        candidateDirs.push(process.env['FNM_DIR']);
      } else if (process.env['LOCALAPPDATA']) {
        candidateDirs.push(path.join(process.env['LOCALAPPDATA'], 'fnm_multishells'));
      }
    }

    for (const dir of candidateDirs) {
      if (!dir) continue;
      let normDir: string;
      try {
        normDir = fs.existsSync(dir) ? (fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir)) : path.normalize(dir);
      } catch {
        normDir = path.normalize(dir);
      }
      const lowerDir = normDir.toLowerCase();

      // Anti-hijack: strictly reject any candidate inside workspace folders
      if (workspacePaths.some(ws => lowerDir.startsWith(ws + path.sep) || lowerDir === ws)) {
        continue;
      }

      const nodeCandidate = path.join(normDir, 'node.exe');
      if (fs.existsSync(nodeCandidate)) {
        let canonicalNode: string;
        try {
          canonicalNode = fs.realpathSync.native ? fs.realpathSync.native(nodeCandidate) : fs.realpathSync(nodeCandidate);
        } catch {
          canonicalNode = path.normalize(nodeCandidate);
        }
        const lowerNode = canonicalNode.toLowerCase();
        if (workspacePaths.some(ws => lowerNode.startsWith(ws + path.sep) || lowerNode === ws)) {
          continue;
        }

        const cliCandidates = [
          path.join(normDir, 'node_modules', 'npm', 'bin', `${tool}-cli.js`),
          path.join(normDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          path.join(normDir, '..', 'lib', 'node_modules', 'npm', 'bin', `${tool}-cli.js`),
          path.join(normDir, `${tool}-cli.js`),
        ];
        if (process.env['APPDATA']) {
          cliCandidates.push(path.join(process.env['APPDATA'], 'npm', 'node_modules', 'npm', 'bin', `${tool}-cli.js`));
        }
        if (process.env['LOCALAPPDATA']) {
          cliCandidates.push(path.join(process.env['LOCALAPPDATA'], 'Volta', 'tools', 'image', 'packages', 'npm', 'bin', `${tool}-cli.js`));
        }

        for (const cand of cliCandidates) {
          if (cand && fs.existsSync(cand)) {
            let canonicalCli: string;
            try {
              canonicalCli = fs.realpathSync.native ? fs.realpathSync.native(cand) : fs.realpathSync(cand);
            } catch {
              canonicalCli = path.normalize(cand);
            }
            const lowerCli = canonicalCli.toLowerCase();
            if (workspacePaths.some(ws => lowerCli.startsWith(ws + path.sep) || lowerCli === ws)) {
              continue;
            }
            return { nodePath: canonicalNode, cliPath: canonicalCli };
          }
        }
      }
    }
    return null;
  }
}
