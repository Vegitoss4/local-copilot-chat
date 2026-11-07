import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { AtomicFileWriter } from './atomicFileWriter';
import { RepositoryIntelligenceService, FileIntelligence, CodeSymbol } from './repositoryIntelligenceService';
import { WorkspaceManager } from './workspaceManager';
import { PathSecurity } from './pathSecurity';

export interface CachedFileEntry {
  mtimeMs: number;
  hash: string;
  intelligence: FileIntelligence;
  centralityScore: number;
}

export interface DiskRepoMapCache {
  version: number;
  lastUpdated: string;
  files: Record<string, CachedFileEntry>;
}

export interface RepoMapGenerateOptions {
  maxTokens?: number; // default ~1000 tokens
  focusFiles?: string[];
}

export class RepositoryMapService {
  private static readonly CACHE_FILENAME = 'repo-map.json';
  private static readonly CURRENT_VERSION = 1;
  private static _instance: RepositoryMapService | undefined;

  private _memoryCache: Map<string, CachedFileEntry> = new Map();
  private _isLoaded: boolean = false;

  public static getInstance(): RepositoryMapService {
    if (!this._instance) {
      this._instance = new RepositoryMapService();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  /**
   * Initializes the repository map service and loads cached index from disk.
   */
  public async init(targetRootUri?: vscode.Uri): Promise<void> {
    const folder = WorkspaceManager.getTargetWorkspaceFolder(targetRootUri);
    if (!folder) return;

    const cacheUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'local-copilot', RepositoryMapService.CACHE_FILENAME);
    const cachedData = await AtomicFileWriter.readJson<DiskRepoMapCache | null>(cacheUri, null);

    if (cachedData && cachedData.version === RepositoryMapService.CURRENT_VERSION && cachedData.files) {
      this._memoryCache.clear();
      for (const [filePath, entry] of Object.entries(cachedData.files)) {
        this._memoryCache.set(filePath, entry as CachedFileEntry);
      }
      this._isLoaded = true;
    }
  }

  /**
   * Updates index for a single file or returns existing cache entry if mtime and hash match.
   */
  public async indexFile(
    fileUri: vscode.Uri,
    content: string,
    mtimeMs?: number
  ): Promise<CachedFileEntry> {
    const fsPath = fileUri.fsPath;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const existing = this._memoryCache.get(fsPath);

    if (existing && existing.hash === hash && (!mtimeMs || existing.mtimeMs === mtimeMs)) {
      return existing;
    }

    const intelService = RepositoryIntelligenceService.getInstance();
    const intelligence = intelService.analyzeAndIndex(fsPath, content);

    const entry: CachedFileEntry = {
      mtimeMs: mtimeMs || Date.now(),
      hash,
      intelligence,
      centralityScore: 1.0 // baseline score, recalculated on graph update
    };

    this._memoryCache.set(fsPath, entry);
    return entry;
  }

  /**
   * Invalidates a file from the index.
   */
  public invalidateFile(fsPath: string): void {
    this._memoryCache.delete(fsPath);
  }

  /**
   * Calculates degree-centrality scores across indexed files based on import references.
   */
  public computeCentralityScores(): void {
    const incomingRefCounts: Map<string, number> = new Map();

    for (const [filePath, entry] of this._memoryCache.entries()) {
      incomingRefCounts.set(filePath, incomingRefCounts.get(filePath) || 1);

      for (const imp of entry.intelligence.imports) {
        // Resolve target import source (basic relative path normalization)
        const dir = path.dirname(filePath);
        let resolvedTarget = path.resolve(dir, imp.source);
        if (!path.extname(resolvedTarget)) {
          // Check if resolvedTarget + .ts or .js exists in cache
          for (const ext of ['.ts', '.js', '.tsx', '.jsx']) {
            if (this._memoryCache.has(resolvedTarget + ext)) {
              resolvedTarget = resolvedTarget + ext;
              break;
            }
          }
        }

        if (this._memoryCache.has(resolvedTarget)) {
          incomingRefCounts.set(resolvedTarget, (incomingRefCounts.get(resolvedTarget) || 1) + 2);
        }
      }
    }

    for (const [filePath, entry] of this._memoryCache.entries()) {
      entry.centralityScore = incomingRefCounts.get(filePath) || 1;
    }
  }

  /**
   * Generates a dense, low-token hierarchical repository map formatted for 7B LLM system prompts.
   */
  public generateRepoMap(options?: RepoMapGenerateOptions): string {
    const maxTokens = options?.maxTokens || 1000;
    const focusSet = new Set(options?.focusFiles || []);

    this.computeCentralityScores();

    // Sort files by centrality score descending, prioritizing focus files
    const sortedEntries = Array.from(this._memoryCache.entries()).sort((a, b) => {
      const aFocus = focusSet.has(a[0]) ? 100 : 0;
      const bFocus = focusSet.has(b[0]) ? 100 : 0;
      return (b[1].centralityScore + bFocus) - (a[1].centralityScore + aFocus);
    });

    const lines: string[] = ['# REPOSITORY ARCHITECTURE MAP'];
    let estimatedTokens = 10;

    for (const [filePath, entry] of sortedEntries) {
      const relPath = path.basename(filePath);
      const symbols = entry.intelligence.symbols.filter(s => s.isExported || s.kind === 'class' || s.kind === 'interface');
      const symbolNames = symbols.slice(0, 8).map(s => `${s.kind} ${s.name}`).join(', ');

      const entryLine = `- ${relPath} (refs: ${entry.centralityScore}): ${symbolNames || 'modules/utilities'}`;
      const lineTokens = Math.ceil(entryLine.length / 4);

      if (estimatedTokens + lineTokens > maxTokens) {
        lines.push(`... [${sortedEntries.length - lines.length} more files omitted to conserve token budget]`);
        break;
      }

      lines.push(entryLine);
      estimatedTokens += lineTokens;
    }

    return lines.join('\n');
  }

  /**
   * Persists the in-memory cache to `.vscode/local-copilot/repo-map.json`.
   */
  public async persistCache(targetRootUri?: vscode.Uri): Promise<void> {
    const folder = WorkspaceManager.getTargetWorkspaceFolder(targetRootUri);
    if (!folder) return;

    const cacheUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'local-copilot', RepositoryMapService.CACHE_FILENAME);
    const filesObj: Record<string, CachedFileEntry> = {};

    for (const [filePath, entry] of this._memoryCache.entries()) {
      filesObj[filePath] = entry;
    }

    const payload: DiskRepoMapCache = {
      version: RepositoryMapService.CURRENT_VERSION,
      lastUpdated: new Date().toISOString(),
      files: filesObj
    };

    await AtomicFileWriter.writeJson(cacheUri, payload);
  }

  /**
   * Gets number of indexed files.
   */
  public getIndexSize(): number {
    return this._memoryCache.size;
  }
}
