import * as crypto from 'crypto';

export interface RepairAttempt {
  iteration: number;
  patchHash: string;
  appliedFiles: string[];
  diagnosticError?: string;
  success: boolean;
}

export interface CodeRepairOptions {
  maxAttempts?: number; // default 3
  allowTestModifications?: boolean; // default false
}

export interface CodeRepairResult {
  success: boolean;
  totalAttempts: number;
  finalError?: string;
  oscillated: boolean;
  testWeakeningDetected: boolean;
  history: RepairAttempt[];
}

export class CodeRepairEngine {
  private static readonly TEST_WEAKENING_PATTERNS = [
    /\b(it|test|describe)\s*\.\s*(skip|only)\b/,
    /\b(xit|xtest|xdescribe)\s*\(/,
    /\/\/\s*(assert|expect|should)\./,
    /\bassert\s*\.\s*(ok|strictEqual|deepStrictEqual|equal)\s*\(\s*(true|1)\s*\)/,
    /\bexpect\s*\([^)]*\)\s*\.\s*(toBe|toEqual)\s*\(\s*(true|1)\s*\)/
  ];

  /**
   * Deterministically inspects a patch or replacement to check if it weakens or deletes tests.
   */
  public static detectTestWeakening(target: string, replacement: string, filePath: string): boolean {
    const isTest = this._isTestFile(filePath);
    if (!isTest) return false;

    // Check if replacement introduces skip or xit patterns
    for (const pattern of this.TEST_WEAKENING_PATTERNS) {
      if (pattern.test(replacement) && !pattern.test(target)) {
        return true;
      }
    }

    // Check if target contained assertions that were completely removed in replacement
    const targetAssertions = (target.match(/\b(assert|expect|should)\b/g) || []).length;
    const repAssertions = (replacement.match(/\b(assert|expect|should)\b/g) || []).length;
    if (targetAssertions > 0 && repAssertions === 0) {
      return true;
    }

    return false;
  }

  /**
   * Hashes a patch for oscillation detection.
   */
  public static hashPatch(target: string, replacement: string, filePath: string): string {
    return crypto.createHash('sha256').update(`${filePath}::${target}::${replacement}`).digest('hex');
  }

  /**
   * Checks whether the current patch was already attempted in prior iterations (oscillation).
   */
  public static isOscillating(currentHash: string, history: RepairAttempt[]): boolean {
    return history.some(h => h.patchHash === currentHash);
  }

  private static _isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('.test.') || lower.includes('.spec.') || lower.includes('/test/') || lower.includes('/tests/');
  }
}
