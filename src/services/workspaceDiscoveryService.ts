import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PathSecurity } from './pathSecurity';
import { AgentToolService } from './agentToolService';
import { ExtensionLogger } from './extensionLogger';

export interface WorkspaceDiscoveryOptions {
  numCtx?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxTimeMs?: number;
  signal?: AbortSignal;
}

export interface PrunedDirectorySummary {
  path: string;
  fileCount: number;
  dominantExtensions: string[];
}

export interface WorkspaceDiscoveryResult {
  rawText: string;
  detectedStacks: string[];
  manifestFiles: string[];
  keyEntryFilesPresent: string[];
  keyEntryFilesMissing: string[];
  hasRelevantFiles: boolean;
  totalFilesDiscovered: number;
  gitBranch?: string;
  diagnosticSummary?: string;
  truncatedFilesCount: number;
  truncatedFiles: string[];
  prunedDirectories?: PrunedDirectorySummary[];
}

export class WorkspaceDiscoveryService {
  private static readonly IGNORED_DIRS = new Set([
    'node_modules',
    'bin',
    'obj',
    'dist',
    '.vs',
    '.git',
    '.idea',
    '.vscode',
    'out',
    'out-test',
    'coverage',
    '.local-copilot',
    '.gemini',
    'build',
  ]);

  private static readonly SENSITIVE_PATTERNS = [
    /^\.env(\..+)?$/i,
    /^.*id_rsa.*$/i,
    /^.*\.pem$/i,
    /^.*\.key$/i,
    /^.*secret.*$/i,
    /^.*credential.*$/i,
  ];

  private static readonly BINARY_EXTENSIONS = new Set([
    '.exe', '.dll', '.bin', '.so', '.dylib', '.png', '.jpg', '.jpeg',
    '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.7z', '.iso',
    '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.db', '.sqlite'
  ]);

  private static readonly KEY_ENTRY_CANDIDATES = [
    'Program.cs',
    'Startup.cs',
    'main.ts',
    'app.module.ts',
    'app.component.ts',
    'index.html',
    'index.ts',
    'index.js',
    'server.ts',
    'server.js',
    'app.ts',
    'app.js',
  ];

  /**
   * Sanitizes untrusted filenames and strings to prevent delimiter forgery,
   * prompt injections, and control character pollution.
   */
  public static sanitizeUntrustedString(input: string): string {
    if (!input) return '';
    let sanitized = input
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/<\/?untrusted_workspace_discovery>/gi, '[neutralized_tag]');

    if (sanitized.length > 120) {
      sanitized = sanitized.slice(0, 117) + '...';
    }
    return sanitized;
  }

  /**
   * Executes deterministic workspace discovery within PathSecurity containment.
   */
  public static async discover(
    workspaceRootUri?: vscode.Uri,
    options?: WorkspaceDiscoveryOptions
  ): Promise<WorkspaceDiscoveryResult> {
    const startTime = Date.now();
    const maxEntries = options?.maxEntries ?? 100;
    const maxDepth = options?.maxDepth ?? 3;
    const maxTimeMs = options?.maxTimeMs ?? 2500;
    const numCtx = options?.numCtx ?? 16384;
    const signal = options?.signal;

    // Derive character budget from numCtx (min 1500 chars, max 8000 chars)
    const charBudget = Math.max(1500, Math.min(8000, Math.floor(numCtx * 0.4)));

    // Target root determination (respects pinned root in multi-root workspaces)
    const rootUri = workspaceRootUri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) {
      return {
        rawText: `<untrusted_workspace_discovery>\nNo workspace folder is open.\n</untrusted_workspace_discovery>`,
        detectedStacks: [],
        manifestFiles: [],
        keyEntryFilesPresent: [],
        keyEntryFilesMissing: [],
        hasRelevantFiles: false,
        totalFilesDiscovered: 0,
        truncatedFilesCount: 0,
        truncatedFiles: [],
      };
    }

    const discoveredFiles: string[] = [];
    const discoveredDirs: string[] = [];
    const manifestFiles: string[] = [];
    const detectedStacks = new Set<string>();
    const entryFilesPresent = new Set<string>();
    const truncatedFiles: string[] = [];
    let truncatedFilesCount = 0;
    const prunedDirectories: PrunedDirectorySummary[] = [];

    // Helper to identify priority manifests and entry points
    const isPriorityEntry = (name: string): boolean => {
      const lower = name.toLowerCase();
      return (
        lower.endsWith('.csproj') ||
        lower.endsWith('.sln') ||
        lower === 'package.json' ||
        lower === 'angular.json' ||
        lower === 'tsconfig.json' ||
        lower === 'pom.xml' ||
        lower === 'requirements.txt' ||
        lower === 'pyproject.toml' ||
        lower === 'cargo.toml' ||
        lower === 'go.mod' ||
        lower === 'launchsettings.json' ||
        WorkspaceDiscoveryService.KEY_ENTRY_CANDIDATES.some(k => k.toLowerCase() === lower)
      );
    };

    // 1. Traverse directory tree bounded by depth, entries, and timeout
    const queue: Array<{ uri: vscode.Uri; relPath: string; depth: number }> = [
      { uri: rootUri, relPath: '', depth: 0 },
    ];

    while (queue.length > 0) {
      if (signal?.aborted || Date.now() - startTime > maxTimeMs) {
        break;
      }

      const current = queue.shift()!;
      if (current.depth > maxDepth) continue;

      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(current.uri);
      } catch {
        // Unreadable directory or permission error; continue safely
        continue;
      }

      // Prioritize manifests, entry points, and directories first
      entries.sort(([nameA, typeA], [nameB, typeB]) => {
        const prioA = isPriorityEntry(nameA) ? 0 : (typeA === vscode.FileType.Directory ? 1 : 2);
        const prioB = isPriorityEntry(nameB) ? 0 : (typeB === vscode.FileType.Directory ? 1 : 2);
        return prioA - prioB;
      });

      for (const [name, type] of entries) {
        if (signal?.aborted || Date.now() - startTime > maxTimeMs) break;

        // Skip ignored directories
        if (this.IGNORED_DIRS.has(name.toLowerCase())) {
          continue;
        }

        // Check sensitive patterns
        if (this.SENSITIVE_PATTERNS.some((p) => p.test(name))) {
          continue;
        }

        const childUri = vscode.Uri.joinPath(current.uri, name);
        const childRelPath = current.relPath ? `${current.relPath}/${name}` : name;

        // Verify PathSecurity containment (prevent symlink / junction escapes)
        try {
          PathSecurity.validatePath(childUri.fsPath, rootUri);
        } catch {
          continue;
        }

        // Verify not a symlink / junction via fs.lstat if available on disk
        try {
          if (fs.existsSync(childUri.fsPath)) {
            const lstat = fs.lstatSync(childUri.fsPath);
            if (lstat.isSymbolicLink()) {
              continue;
            }
          }
        } catch {}

        if (type === vscode.FileType.Directory) {
          if (current.depth < maxDepth) {
            discoveredDirs.push(this.sanitizeUntrustedString(childRelPath));
            queue.push({
              uri: childUri,
              relPath: childRelPath,
              depth: current.depth + 1,
            });
          } else {
            // Pruned directory beyond max search depth: collect recursive compact summary
            try {
              const remainingBudget = Math.max(100, maxTimeMs - (Date.now() - startTime));
              const { fileCount, dominantExtensions } = await WorkspaceDiscoveryService.countFilesRecursive(
                childUri,
                signal,
                Math.min(500, remainingBudget),
                Date.now(),
                1000
              );
              prunedDirectories.push({
                path: this.sanitizeUntrustedString(childRelPath),
                fileCount,
                dominantExtensions,
              });
            } catch {}
          }
        } else if (type === vscode.FileType.File) {
          const ext = path.extname(name).toLowerCase();
          if (this.BINARY_EXTENSIONS.has(ext)) {
            continue;
          }

          const sanitizedRelPath = this.sanitizeUntrustedString(childRelPath);

          if (discoveredFiles.length >= maxEntries) {
            truncatedFilesCount++;
            if (truncatedFiles.length < 15) {
              truncatedFiles.push(sanitizedRelPath);
            }
            continue;
          }

          discoveredFiles.push(sanitizedRelPath);

          // Manifest & Stack Detection
          const lowerName = name.toLowerCase();
          if (lowerName.endsWith('.csproj') || lowerName.endsWith('.sln')) {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('ASP.NET Core / .NET');
          } else if (lowerName === 'package.json') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('Node.js');
            // Inspect package.json dependencies for frameworks
            try {
              const contentBytes = await vscode.workspace.fs.readFile(childUri);
              const pkgText = Buffer.from(contentBytes).toString('utf-8');
              const pkg = JSON.parse(pkgText);
              const deps = { ...pkg.dependencies, ...pkg.devDependencies };
              if (deps['@angular/core']) detectedStacks.add('Angular');
              if (deps['react']) detectedStacks.add('React');
              if (deps['vue']) detectedStacks.add('Vue');
              if (deps['express']) detectedStacks.add('Express');
              if (deps['typescript']) detectedStacks.add('TypeScript');
            } catch {}
          } else if (lowerName === 'angular.json') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('Angular');
          } else if (lowerName === 'tsconfig.json') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('TypeScript');
          } else if (lowerName === 'pom.xml') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('Java Maven');
          } else if (lowerName === 'requirements.txt' || lowerName === 'pyproject.toml') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('Python');
          } else if (lowerName === 'cargo.toml') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('Rust Cargo');
          } else if (lowerName === 'go.mod') {
            manifestFiles.push(sanitizedRelPath);
            detectedStacks.add('Go');
          }

          // Key Entry File Matching
          if (this.KEY_ENTRY_CANDIDATES.includes(name)) {
            entryFilesPresent.add(name);
          }
        }
      }
    }

    // Key entry files missing (based on detected stacks)
    const entryFilesMissing: string[] = [];
    if (detectedStacks.has('ASP.NET Core / .NET') && !entryFilesPresent.has('Program.cs') && !entryFilesPresent.has('Startup.cs')) {
      entryFilesMissing.push('Program.cs');
    }
    if (detectedStacks.has('Angular') && !entryFilesPresent.has('main.ts')) {
      entryFilesMissing.push('Frontend.Client/main.ts (or src/main.ts)');
    }

    // 2. Git Status Summary (Read-only via GitExecutionIsolator)
    let gitSummary = 'Git: Not a repository or git unavailable';
    let gitBranch = '';
    try {
      const gitRes = await AgentToolService.executeCommand('git status --short --branch');
      if (gitRes.exitCode === 0 && gitRes.stdout) {
        const lines = gitRes.stdout.trim().split('\n').slice(0, 10);
        const branchLine = lines[0] || '';
        gitBranch = branchLine.replace('##', '').trim();
        gitSummary = lines.map((l) => this.sanitizeUntrustedString(l)).join('\n');
      }
    } catch {}

    // 3. Diagnostics Summary (Editor only; never executes unapproved build commands)
    let diagSummary = '0 active editor diagnostics reported (note: unanalyzed files may have build errors; builds must be approved).';
    try {
      const allDiags = vscode.languages.getDiagnostics();
      const relevantDiags: string[] = [];
      for (const [uri, diags] of allDiags) {
        if (uri.fsPath.startsWith(rootUri.fsPath)) {
          for (const d of diags) {
            const rel = path.relative(rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
            relevantDiags.push(`${this.sanitizeUntrustedString(rel)}:${d.range.start.line + 1}: [${d.code || 'diagnostic'}] ${this.sanitizeUntrustedString(d.message)}`);
            if (relevantDiags.length >= 8) break;
          }
        }
        if (relevantDiags.length >= 8) break;
      }
      if (relevantDiags.length > 0) {
        diagSummary = `Active editor diagnostics (${relevantDiags.length} shown, only covers files VS Code has analyzed):\n` +
          relevantDiags.map((d) => `  - ${d}`).join('\n');
      }
    } catch {}

    const hasRelevantFiles = discoveredFiles.length > 0 || manifestFiles.length > 0;
    const stacksList = Array.from(detectedStacks);

    // 4. Assemble delimited, bounded output
    let body = `[Workspace Overview - Pinned Root: ${this.sanitizeUntrustedString(path.basename(rootUri.fsPath))}]\n`;
    body += `Total Discovered Files: ${discoveredFiles.length} (depth <= ${maxDepth})\n`;

    if (stacksList.length > 0) {
      body += `Detected Frameworks/Stacks: ${stacksList.join(', ')}\n`;
    } else {
      body += `Detected Frameworks/Stacks: None detected from manifests\n`;
    }

    if (manifestFiles.length > 0) {
      body += `Manifest Files Found:\n` + manifestFiles.slice(0, 8).map((m) => `  - ${m}`).join('\n') + '\n';
    }

    if (entryFilesPresent.size > 0) {
      body += `Key Entry Files Present: ${Array.from(entryFilesPresent).join(', ')}\n`;
    }
    if (entryFilesMissing.length > 0) {
      body += `Key Entry Files Missing / Expected: ${entryFilesMissing.join(', ')}\n`;
    }

    body += `\nGit Status (${gitBranch ? `Branch: ${this.sanitizeUntrustedString(gitBranch)}` : 'Read-only'}):\n${gitSummary}\n`;
    body += `\nCompiler/LSP Diagnostics:\n${diagSummary}\n`;

    if (discoveredFiles.length > 0) {
      body += `\nFile Tree Excerpt (Top ${Math.min(30, discoveredFiles.length)} files):\n`;
      body += discoveredFiles.slice(0, 30).map((f) => `  ${f}`).join('\n') + '\n';
    }

    if (truncatedFilesCount > 0) {
      body += `\n[Notice: ${truncatedFilesCount} additional files omitted due to entry cap (${maxEntries})]\n`;
    }

    if (prunedDirectories.length > 0) {
      // Prioritize source directories for detected stacks
      prunedDirectories.sort((a, b) => {
        const isSrcA = /src|app|feature|component|controller|service/i.test(a.path) ? 0 : 1;
        const isSrcB = /src|app|feature|component|controller|service/i.test(b.path) ? 0 : 1;
        return isSrcA - isSrcB;
      });
      body += `\n[Pruned Subtrees (beyond search depth ${maxDepth})]:\n`;
      for (const pd of prunedDirectories.slice(0, 10)) {
        const exts = pd.dominantExtensions.length > 0 ? `, dominant: ${pd.dominantExtensions.join(', ')}` : '';
        body += `  - ${pd.path} (${pd.fileCount} items${exts})\n`;
      }
    }

    // Apply strict character budget derived from numCtx
    if (body.length > charBudget) {
      body = body.slice(0, charBudget - 65) + '\n[... Workspace discovery truncated to fit context budget ...]';
    }

    const rawText = `<untrusted_workspace_discovery>\n${body}\n</untrusted_workspace_discovery>`;

    ExtensionLogger.info(
      `[WorkspaceDiscovery] Discovered ${discoveredFiles.length} files (${truncatedFilesCount} truncated, ${prunedDirectories.length} pruned dirs), ${manifestFiles.length} manifests, stacks: [${stacksList.join(', ')}], budget: ${charBudget} chars.`
    );

    return {
      rawText,
      detectedStacks: stacksList,
      manifestFiles,
      keyEntryFilesPresent: Array.from(entryFilesPresent),
      keyEntryFilesMissing: entryFilesMissing,
      hasRelevantFiles,
      totalFilesDiscovered: discoveredFiles.length,
      gitBranch,
      diagnosticSummary: diagSummary,
      truncatedFilesCount,
      truncatedFiles,
      prunedDirectories,
    };
  }

  /**
   * Recursively counts files and collects dominant extensions in a pruned subdirectory.
   * Strictly bounded by time and maximum items.
   */
  public static async countFilesRecursive(
    dirUri: vscode.Uri,
    signal?: vscode.CancellationToken | AbortSignal,
    maxTimeMs = 500,
    startTime = Date.now(),
    maxCount = 1000
  ): Promise<{ fileCount: number; dominantExtensions: string[] }> {
    const extMap: Record<string, number> = {};
    let fileCount = 0;
    const queue: vscode.Uri[] = [dirUri];

    while (queue.length > 0) {
      const isAborted = (signal as any)?.aborted || (signal as any)?.isCancellationRequested;
      if (isAborted || Date.now() - startTime > maxTimeMs || fileCount >= maxCount) {
        break;
      }
      const current = queue.shift()!;
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(current);
      } catch {
        if (fs.existsSync(current.fsPath)) {
          try {
            const raw = fs.readdirSync(current.fsPath, { withFileTypes: true });
            entries = raw.map(r => [r.name, r.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File]);
          } catch {}
        }
      }

      for (const [name, type] of entries) {
        if (this.IGNORED_DIRS.has(name.toLowerCase()) || this.SENSITIVE_PATTERNS.some(p => p.test(name))) {
          continue;
        }
        const childUri = vscode.Uri.joinPath(current, name);
        if (type === vscode.FileType.Directory) {
          queue.push(childUri);
        } else if (type === vscode.FileType.File) {
          fileCount++;
          const ext = path.extname(name).toLowerCase();
          if (ext) {
            extMap[ext] = (extMap[ext] || 0) + 1;
          }
        }
      }
    }

    const dominant = Object.entries(extMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ext]) => ext);

    return { fileCount, dominantExtensions: dominant };
  }
}
