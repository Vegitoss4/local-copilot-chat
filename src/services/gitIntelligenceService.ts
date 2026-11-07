import * as vscode from 'vscode';
import { AgentToolService } from './agentToolService';
import { OllamaService } from './ollamaService';

/**
 * Deliverable 11.7: Git-Aware Development
 * Provides structured Git repository intelligence, diff inspection,
 * Conventional Commit synthesis, and PR description generation while
 * strictly enforcing read-only safety invariants.
 */

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
}

export interface GitWorkingTreeStatus {
  isClean: boolean;
  branch: string;
  files: GitFileStatus[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

export interface GitDiffFileSummary {
  filePath: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface StructuredDiff {
  rawDiff: string;
  files: GitDiffFileSummary[];
  totalAdditions: number;
  totalDeletions: number;
}

export class GitIntelligenceService {
  private static _instance: GitIntelligenceService | undefined;

  public static getInstance(): GitIntelligenceService {
    if (!this._instance) {
      this._instance = new GitIntelligenceService();
    }
    return this._instance;
  }

  /**
   * Parses git status --short and git branch output into structured data.
   */
  public async getWorkingTreeStatus(): Promise<GitWorkingTreeStatus> {
    try {
      const statusRes = await AgentToolService.executeCommand('git status --short --branch');
      const stdout = statusRes.stdout || '';
      return GitIntelligenceService.parseStatusOutput(stdout);
    } catch {
      return {
        isClean: true,
        branch: 'unknown',
        files: [],
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0
      };
    }
  }

  /**
   * Pure parser for git status --short output.
   */
  public static parseStatusOutput(output: string): GitWorkingTreeStatus {
    const lines = output.split(/\r?\n/).filter(l => l.trim().length > 0);
    let branch = 'main';
    const files: GitFileStatus[] = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        const branchPart = line.slice(3).trim();
        branch = branchPart.split('...')[0] || 'main';
        continue;
      }

      const x = line[0];
      const y = line[1];
      const filePath = line.slice(3).trim();

      if (x === '?' && y === '?') {
        files.push({ path: filePath, status: 'untracked', staged: false });
      } else {
        if (x !== ' ' && x !== '?') {
          files.push({
            path: filePath,
            status: x === 'M' ? 'modified' : (x === 'A' ? 'added' : (x === 'D' ? 'deleted' : 'renamed')),
            staged: true
          });
        }
        if (y !== ' ' && y !== '?') {
          files.push({
            path: filePath,
            status: y === 'M' ? 'modified' : (y === 'A' ? 'added' : (y === 'D' ? 'deleted' : 'renamed')),
            staged: false
          });
        }
      }
    }

    const stagedCount = files.filter(f => f.staged).length;
    const unstagedCount = files.filter(f => !f.staged && f.status !== 'untracked').length;
    const untrackedCount = files.filter(f => f.status === 'untracked').length;

    return {
      isClean: files.length === 0,
      branch,
      files,
      stagedCount,
      unstagedCount,
      untrackedCount
    };
  }

  /**
   * Retrieves and parses structured git diff with per-file additions and deletions.
   */
  public async getStructuredDiff(cached: boolean = false): Promise<StructuredDiff> {
    try {
      const diffCmd = cached ? 'git diff --cached' : 'git diff';
      const statCmd = cached ? 'git diff --cached --numstat' : 'git diff --numstat';

      const diffRes = await AgentToolService.executeCommand(diffCmd);
      const statRes = await AgentToolService.executeCommand(statCmd);

      return GitIntelligenceService.parseNumstatOutput(diffRes.stdout || '', statRes.stdout || '');
    } catch {
      return {
        rawDiff: '',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0
      };
    }
  }

  /**
   * Pure parser for git diff --numstat output.
   */
  public static parseNumstatOutput(rawDiff: string, numstat: string): StructuredDiff {
    const lines = numstat.split(/\r?\n/).filter(l => l.trim().length > 0);
    const files: GitDiffFileSummary[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const isBin = parts[0] === '-' && parts[1] === '-';
        const adds = isBin ? 0 : (parseInt(parts[0], 10) || 0);
        const dels = isBin ? 0 : (parseInt(parts[1], 10) || 0);
        const filePath = parts[2].trim();

        totalAdditions += adds;
        totalDeletions += dels;

        files.push({
          filePath,
          additions: adds,
          deletions: dels,
          isBinary: isBin
        });
      }
    }

    return {
      rawDiff,
      files,
      totalAdditions,
      totalDeletions
    };
  }

  /**
   * Synthesizes a conventional commit proposal based on the active diff using Ollama.
   */
  public async generateConventionalCommit(
    diffSummary: StructuredDiff,
    ollamaService: OllamaService,
    model: string
  ): Promise<string> {
    if (!diffSummary.files || diffSummary.files.length === 0) {
      return 'feat: update workspace implementation';
    }

    const fileList = diffSummary.files.map(f => `${f.filePath} (+${f.additions}/-${f.deletions})`).join('\n');
    const truncatedDiff = diffSummary.rawDiff.slice(0, 3000);

    const prompt =
      'You are a git commit expert. Analyze this git diff and write a concise, professional Conventional Commit message.\n' +
      'Format strictly as:\n' +
      '<type>(<scope>): <short description in present tense>\n\n' +
      '[optional body explaining motivation]\n\n' +
      `Modified files:\n${fileList}\n\n` +
      `Diff snippet:\n${truncatedDiff}`;

    try {
      const result = await ollamaService.streamChat(
        model,
        [
          { role: 'system', content: 'Output ONLY the commit message. No commentary or code fences.' },
          { role: 'user', content: prompt }
        ],
        () => {},
        undefined,
        { temperature: 0.1 }
      );
      return result.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
    } catch {
      const primaryFile = diffSummary.files[0]?.filePath || 'code';
      return `feat: update ${primaryFile}`;
    }
  }

  /**
   * Generates a complete GitHub Markdown Pull Request description.
   */
  public async generatePrDescription(
    diffSummary: StructuredDiff,
    ollamaService: OllamaService,
    model: string,
    titleHint?: string
  ): Promise<string> {
    const fileList = diffSummary.files.map(f => `| \`${f.filePath}\` | +${f.additions} | -${f.deletions} |`).join('\n');
    const truncatedDiff = diffSummary.rawDiff.slice(0, 4000);

    const prompt =
      'Synthesize a comprehensive Pull Request description in GitHub Markdown format based on this diff.\n' +
      'Include:\n' +
      '1. Summary of changes and motivation.\n' +
      '2. Key architectural modifications.\n' +
      '3. Verification & testing evidence.\n' +
      '4. Risk assessment.\n\n' +
      `Diff snippet:\n${truncatedDiff}`;

    let generatedBody = '';
    try {
      generatedBody = await ollamaService.streamChat(
        model,
        [
          { role: 'system', content: 'You are a senior software architect creating a GitHub Pull Request description.' },
          { role: 'user', content: prompt }
        ],
        () => {},
        undefined,
        { temperature: 0.2 }
      );
    } catch {
      generatedBody = '### Summary\nUpdates workspace implementation with improved reliability and features.';
    }

    let pr = `## ${titleHint || 'PR: Workspace Implementation Updates'}\n\n`;
    pr += generatedBody.trim() + '\n\n';
    pr += `### File Change Matrix\n\n`;
    pr += `| File | Additions | Deletions |\n| :--- | :--- | :--- |\n`;
    pr += (fileList || '| None | 0 | 0 |') + '\n\n';
    pr += `**Total Changes**: +${diffSummary.totalAdditions} / -${diffSummary.totalDeletions} across ${diffSummary.files.length} files.`;

    return pr;
  }
}
