import * as vscode from 'vscode';
import * as path from 'path';
import { RepositoryIntelligenceService, FileIntelligence, CodeSymbol } from './repositoryIntelligenceService';
import { WorkspaceManager } from './workspaceManager';

export interface CallerReference {
  filePath: string;
  line: number;
  snippet: string;
  isTestFile: boolean;
}

export interface ImpactReport {
  targetSymbol: string;
  targetFile: string;
  directCallers: CallerReference[];
  affectedTests: CallerReference[];
  totalCallersCount: number;
  hasDynamicOrUntypedCallers: boolean;
  recommendedEditFiles: string[];
}

export interface PlannedFilePatch {
  filePath: string;
  target: string;
  replacement: string;
}

export interface MultiFileEditSet {
  transactionId: string;
  objective: string;
  patches: PlannedFilePatch[];
  impactReport: ImpactReport;
}

export class ImpactAnalysisService {
  private static _instance: ImpactAnalysisService | undefined;

  public static getInstance(): ImpactAnalysisService {
    if (!this._instance) {
      this._instance = new ImpactAnalysisService();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  /**
   * Identifies all direct callers and dependent test files across the indexed repository.
   */
  public async analyzeImpact(
    symbolName: string,
    targetFilePath: string,
    workspaceFiles?: Map<string, string> // optional in-memory file contents map for fast testing/execution
  ): Promise<ImpactReport> {
    const intelService = RepositoryIntelligenceService.getInstance();
    const directCallers: CallerReference[] = [];
    const affectedTests: CallerReference[] = [];
    let hasDynamicOrUntypedCallers = false;

    const normTarget = path.normalize(targetFilePath).toLowerCase();
    const targetBaseName = path.basename(targetFilePath, path.extname(targetFilePath));

    // If file map provided, scan each file
    if (workspaceFiles) {
      for (const [filePath, content] of workspaceFiles.entries()) {
        const normPath = path.normalize(filePath).toLowerCase();
        if (normPath === normTarget) continue; // Skip target itself

        this._scanFileForSymbol(filePath, content, symbolName, directCallers, affectedTests);
      }
    } else {
      // Otherwise scan via RepositoryIntelligenceService indexed files
      // and read candidate files
      const candidateFiles = await this._findPotentialCallerFiles(symbolName, targetBaseName);
      for (const fileUri of candidateFiles) {
        const normPath = path.normalize(fileUri.fsPath).toLowerCase();
        if (normPath === normTarget) continue;

        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          this._scanFileForSymbol(fileUri.fsPath, doc.getText(), symbolName, directCallers, affectedTests);
        } catch {
          // File unreadable
        }
      }
    }

    const recommendedEditFiles = Array.from(new Set([
      targetFilePath,
      ...directCallers.map(c => c.filePath),
      ...affectedTests.map(t => t.filePath)
    ]));

    return {
      targetSymbol: symbolName,
      targetFile: targetFilePath,
      directCallers,
      affectedTests,
      totalCallersCount: directCallers.length + affectedTests.length,
      hasDynamicOrUntypedCallers,
      recommendedEditFiles
    };
  }

  /**
   * Builds a planned multi-file edit set from coordinated signature updates.
   */
  public buildEditSet(
    objective: string,
    impactReport: ImpactReport,
    patches: PlannedFilePatch[]
  ): MultiFileEditSet {
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return {
      transactionId,
      objective,
      patches,
      impactReport
    };
  }

  private _scanFileForSymbol(
    filePath: string,
    content: string,
    symbolName: string,
    directCallers: CallerReference[],
    affectedTests: CallerReference[]
  ): void {
    const lines = content.split(/\r?\n/);
    const isTest = this._isTestFile(filePath);
    // Regex looking for word boundary around symbol name
    const symbolRegex = new RegExp(`\\b${this._escapeRegex(symbolName)}\\b`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (symbolRegex.test(line)) {
        // Exclude import statements from direct callers list
        if (/^\s*import\b/.test(line) && !line.includes('(')) {
          continue;
        }

        const ref: CallerReference = {
          filePath,
          line: i + 1,
          snippet: line.trim(),
          isTestFile: isTest
        };

        if (isTest) {
          affectedTests.push(ref);
        } else {
          directCallers.push(ref);
        }
      }
    }
  }

  private _isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('.test.') || lower.includes('.spec.') || lower.includes('/test/') || lower.includes('/tests/');
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async _findPotentialCallerFiles(symbolName: string, targetBaseName: string): Promise<vscode.Uri[]> {
    const folder = WorkspaceManager.getTargetWorkspaceFolder();
    if (!folder) return [];

    try {
      // Find files containing the target basename or symbol
      const files = await vscode.workspace.findFiles('**/*.{ts,js,tsx,jsx}', '**/node_modules/**');
      return files;
    } catch {
      return [];
    }
  }
}
