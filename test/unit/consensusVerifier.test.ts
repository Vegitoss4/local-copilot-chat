import * as assert from 'assert';
import { ConsensusVerifier } from '../../src/services/consensusVerifier';
import { WhiteboardCoordinator } from '../../src/services/whiteboardCoordinator';

describe('Phase 10.6: Multi-Agent Review & Consensus Verification Suite', () => {
  let whiteboard: WhiteboardCoordinator;

  beforeEach(() => {
    WhiteboardCoordinator.resetInstance();
    whiteboard = WhiteboardCoordinator.getInstance();
  });

  it('should reach consensus when all deterministic and agent checks pass', () => {
    const res = ConsensusVerifier.evaluateConsensus(
      {
        reviewRequest: {
          objective: 'Add helper',
          patches: [{ filePath: 'src/util.ts', target: 'let a = 1;', replacement: 'const a = 1;' }]
        },
        testerResult: { role: 'tester', passed: true, testCommandsRun: ['npm test'], failedCount: 0 },
        reviewerResult: { role: 'reviewer', decision: 'APPROVED', blockingIssues: [], qualityScore: 90 },
        securityResult: { role: 'security', clean: true, violations: [], threatLevel: 'low' }
      },
      whiteboard
    );

    assert.strictEqual(res.reached, true);
    assert.strictEqual(res.decision, 'CONSENSUS_REACHED');
    assert.strictEqual(res.vetoingAgent, undefined);
    assert.ok(res.approvals.includes('deterministic_gates'));
    assert.ok(res.approvals.includes('tester'));
    assert.ok(res.approvals.includes('reviewer'));
    assert.ok(res.approvals.includes('security_auditor'));
  });

  it('should reject consensus when deterministic pre-checks fail', () => {
    const res = ConsensusVerifier.evaluateConsensus({
      reviewRequest: {
        objective: 'Malicious patch',
        patches: [{ filePath: '.env', target: 'PORT=3000', replacement: 'PORT=8080' }]
      }
    });

    assert.strictEqual(res.reached, false);
    assert.strictEqual(res.decision, 'CONSENSUS_REJECTED');
    assert.strictEqual(res.vetoingAgent, 'deterministic_gates');
  });

  it('should reject consensus when tester reports failures', () => {
    const res = ConsensusVerifier.evaluateConsensus({
      reviewRequest: {
        objective: 'Broken fix',
        patches: [{ filePath: 'src/fix.ts', target: 'a;', replacement: 'b;' }]
      },
      testerResult: {
        role: 'tester',
        passed: false,
        testCommandsRun: ['npm test'],
        failedCount: 2,
        failureSummary: '2 unit tests failed'
      }
    });

    assert.strictEqual(res.reached, false);
    assert.strictEqual(res.vetoingAgent, 'tester');
  });

  it('should reject consensus when security auditor flags high threat', () => {
    const res = ConsensusVerifier.evaluateConsensus({
      reviewRequest: {
        objective: 'Suspicious change',
        patches: [{ filePath: 'src/net.ts', target: 'a;', replacement: 'b;' }]
      },
      securityResult: {
        role: 'security',
        clean: false,
        violations: ['Detected command injection vector'],
        threatLevel: 'high'
      }
    });

    assert.strictEqual(res.reached, false);
    assert.strictEqual(res.vetoingAgent, 'security_auditor');
  });
});
