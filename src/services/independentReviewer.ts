import { PathSecurity } from './pathSecurity';
import { CodeRepairEngine } from './codeRepairEngine';

export interface ReviewComment {
  filePath: string;
  line?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  ruleId: string;
}

export interface ReviewRequest {
  objective: string;
  patches: Array<{ filePath: string; target: string; replacement: string; fullContent?: string }>;
  compilerErrors?: string[];
  testOutput?: string;
}

export interface ReviewResult {
  decision: 'APPROVED' | 'REJECTED';
  blockingErrors: string[];
  warnings: string[];
  comments: ReviewComment[];
  deterministicChecksPassed: boolean;
}

export class IndependentReviewer {
  private static readonly SECRET_PATTERNS = [
    /(?:sk-[a-zA-Z0-9]{32,})/,
    /(?:ghp_[a-zA-Z0-9]{36,})/,
    /(?:BEGIN (?:RSA |EC )?PRIVATE KEY)/,
    /(?:aws_secret_access_key\s*=\s*['"][a-zA-Z0-9/+=]{40}['"])/,
    /(?:password\s*[:=]\s*['"][^'"]{8,}['"])/i
  ];

  /**
   * Executes deterministic pre-checks before running LLM-assisted code review.
   */
  public static reviewPatches(request: ReviewRequest): ReviewResult {
    const blockingErrors: string[] = [];
    const warnings: string[] = [];
    const comments: ReviewComment[] = [];

    // Check 1: Compiler Diagnostics
    if (request.compilerErrors && request.compilerErrors.length > 0) {
      for (const err of request.compilerErrors) {
        blockingErrors.push(`Compiler error: ${err}`);
        comments.push({
          filePath: 'workspace',
          severity: 'error',
          message: err,
          ruleId: 'COMPILER_DIAGNOSTIC'
        });
      }
    }

    for (const patch of request.patches) {
      // Check 2: Sensitive Target Modifications
      if (PathSecurity.isSensitiveTarget(patch.filePath)) {
        blockingErrors.push(`Security violation: Modifications to sensitive target "${patch.filePath}" are blocked.`);
        comments.push({
          filePath: patch.filePath,
          severity: 'error',
          message: 'Sensitive target modification prohibited',
          ruleId: 'SEC_SENSITIVE_TARGET'
        });
      }

      // Check 3: Secret Leaks
      for (const pattern of this.SECRET_PATTERNS) {
        if (pattern.test(patch.replacement)) {
          blockingErrors.push(`Security leak: Patch introduces potential hardcoded secret in "${patch.filePath}".`);
          comments.push({
            filePath: patch.filePath,
            severity: 'error',
            message: 'Potential secret detected in patch',
            ruleId: 'SEC_HARDCODED_SECRET'
          });
          break;
        }
      }

      // Check 4: Test Weakening Detection
      if (CodeRepairEngine.detectTestWeakening(patch.target, patch.replacement, patch.filePath)) {
        blockingErrors.push(`Quality violation: Test weakening or skip detected in "${patch.filePath}".`);
        comments.push({
          filePath: patch.filePath,
          severity: 'error',
          message: 'Test weakening or test skipping is not permitted',
          ruleId: 'QUALITY_TEST_WEAKENING'
        });
      }
    }

    const deterministicChecksPassed = blockingErrors.length === 0;
    const decision: 'APPROVED' | 'REJECTED' = deterministicChecksPassed ? 'APPROVED' : 'REJECTED';

    return {
      decision,
      blockingErrors,
      warnings,
      comments,
      deterministicChecksPassed
    };
  }

  /**
   * Filters out review comments referencing hallucinated (out-of-bounds) line numbers.
   */
  public static pruneHallucinatedComments(
    comments: ReviewComment[],
    fileLineCounts: Record<string, number>
  ): ReviewComment[] {
    return comments.filter(c => {
      if (!c.line) return true; // File-level comment is retained
      const maxLines = fileLineCounts[c.filePath];
      if (typeof maxLines === 'number' && (c.line < 1 || c.line > maxLines)) {
        return false; // Prune hallucinated comment
      }
      return true;
    });
  }
}
