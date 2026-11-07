import { IndependentReviewer, ReviewRequest } from './independentReviewer';
import { TesterOutput, ReviewerOutput, SecurityAuditorOutput } from './typedAgentContracts';
import { WhiteboardCoordinator } from './whiteboardCoordinator';

export interface ConsensusEvaluationInput {
  reviewRequest: ReviewRequest;
  testerResult?: TesterOutput;
  reviewerResult?: ReviewerOutput;
  securityResult?: SecurityAuditorOutput;
}

export interface ConsensusVerificationResult {
  reached: boolean;
  decision: 'CONSENSUS_REACHED' | 'CONSENSUS_REJECTED';
  approvals: string[];
  rejections: string[];
  vetoingAgent?: string;
  summary: string;
}

export class ConsensusVerifier {
  /**
   * Verifies unanimous multi-agent consensus before permitting transactional patch commits.
   */
  public static evaluateConsensus(
    input: ConsensusEvaluationInput,
    whiteboard?: WhiteboardCoordinator
  ): ConsensusVerificationResult {
    const approvals: string[] = [];
    const rejections: string[] = [];

    // Stage 1: Deterministic security & quality checks
    const deterministicReview = IndependentReviewer.reviewPatches(input.reviewRequest);
    if (!deterministicReview.deterministicChecksPassed) {
      rejections.push(`deterministic_gates: ${deterministicReview.blockingErrors.join('; ')}`);
      return this._recordResult(
        'deterministic_gates',
        false,
        approvals,
        rejections,
        `Deterministic pre-checks failed: ${deterministicReview.blockingErrors.join('; ')}`,
        whiteboard,
        input.reviewRequest.objective
      );
    }
    approvals.push('deterministic_gates');

    // Stage 2: Security Auditor verification
    if (input.securityResult) {
      if (!input.securityResult.clean || input.securityResult.threatLevel === 'high' || input.securityResult.threatLevel === 'critical') {
        rejections.push(`security_auditor: Threat level ${input.securityResult.threatLevel}. ${input.securityResult.violations.join('; ')}`);
        return this._recordResult(
          'security_auditor',
          false,
          approvals,
          rejections,
          `Security auditor rejected: ${input.securityResult.violations.join('; ')}`,
          whiteboard,
          input.reviewRequest.objective
        );
      }
      approvals.push('security_auditor');
    }

    // Stage 3: Tester verification
    if (input.testerResult) {
      if (!input.testerResult.passed || input.testerResult.failedCount > 0) {
        rejections.push(`tester: ${input.testerResult.failedCount} test(s) failed. ${input.testerResult.failureSummary || ''}`);
        return this._recordResult(
          'tester',
          false,
          approvals,
          rejections,
          `Tester verification failed with ${input.testerResult.failedCount} test failures`,
          whiteboard,
          input.reviewRequest.objective
        );
      }
      approvals.push('tester');
    }

    // Stage 4: Code Reviewer verification
    if (input.reviewerResult) {
      if (input.reviewerResult.decision !== 'APPROVED' || input.reviewerResult.qualityScore < 75 || input.reviewerResult.blockingIssues.length > 0) {
        rejections.push(`reviewer: ${input.reviewerResult.blockingIssues.join('; ')}`);
        return this._recordResult(
          'reviewer',
          false,
          approvals,
          rejections,
          `Code reviewer rejected changes: ${input.reviewerResult.blockingIssues.join('; ')}`,
          whiteboard,
          input.reviewRequest.objective
        );
      }
      approvals.push('reviewer');
    }

    return this._recordResult(
      undefined,
      true,
      approvals,
      rejections,
      `Unanimous consensus reached across [${approvals.join(', ')}]`,
      whiteboard,
      input.reviewRequest.objective
    );
  }

  private static _recordResult(
    vetoingAgent: string | undefined,
    reached: boolean,
    approvals: string[],
    rejections: string[],
    summary: string,
    whiteboard?: WhiteboardCoordinator,
    actionDesc?: string
  ): ConsensusVerificationResult {
    const decision = reached ? 'CONSENSUS_REACHED' : 'CONSENSUS_REJECTED';

    if (whiteboard) {
      const state = whiteboard.getState();
      state.consensusRecords.push({
        targetAction: actionDesc || 'Apply transactional edit set',
        approvals: approvals as any[],
        rejections: rejections as any[],
        decision: reached ? 'APPROVED' : 'REJECTED',
        timestamp: Date.now()
      });
    }

    return {
      reached,
      decision,
      approvals,
      rejections,
      vetoingAgent,
      summary
    };
  }
}
