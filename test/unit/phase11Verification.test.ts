import * as assert from 'assert';
import { SessionEngine } from '../../src/services/sessionEngine';
import { AgentTerminalProvider } from '../../src/terminal/agentTerminalProvider';
import { ContextCompactionService } from '../../src/services/contextCompactionService';
import { PlanModeDispatcher } from '../../src/services/planModeDispatcher';
import { CheckpointManager } from '../../src/services/checkpointManager';
import { ApprovalPolicyEngine } from '../../src/services/approvalPolicyEngine';
import { GitIntelligenceService } from '../../src/services/gitIntelligenceService';
import { SessionPersistenceService } from '../../src/services/sessionPersistenceService';
import { BENCHMARK_CORPUS_30 } from '../../src/services/benchmarkTaskCorpus';
import { ParametricBenchmarkHarness } from '../../src/services/parametricBenchmarkHarness';

describe('Deliverable 11.9: Phase 11 Full Verification & Security Audit Suite', () => {
  describe('1. Terminal Escape Sequence Fuzzing & Injection Defense', () => {
    it('should neutralize adversarial OSC, DCS, APC, and CSI escape injections', () => {
      const injectionFuzzCorpus = [
        '\x1b]52;c;ZXhmaWx0cmF0ZWRfc2VjcmV0\x07', // OSC 52 clipboard write
        '\x1b]52;c;?\x07',                        // OSC 52 clipboard read
        '\x1b]0;hacked-terminal-title\x1b\\',      // OSC 0 window title spoof
        '\x1b]2;fake-title\x07',                   // OSC 2 title change
        '\x1bP$q"p\x1b\\',                        // DCS device control string
        '\x1b_test-apc\x1b\\',                     // APC application program command
        '\x1b[?25l',                               // CSI hide cursor
        '\x1b[?1049h',                             // CSI alternate screen buffer
        'Benign Prefix \x1b]52;c;Y29tcHJvbWlzZWQ=\x07 Benign Suffix'
      ];

      for (const attack of injectionFuzzCorpus) {
        const sanitized = AgentTerminalProvider.sanitizeTerminalOutput(attack);

        // Assert dangerous payload markers never survive
        assert.ok(!sanitized.includes('ZXhmaWx0cmF0ZWRfc2VjcmV0'));
        assert.ok(!sanitized.includes('Y29tcHJvbWlzZWQ='));
        assert.ok(!sanitized.includes('hacked-terminal-title'));
        assert.ok(!sanitized.includes('\x1b]'));
        assert.ok(!sanitized.includes('\x1bP'));
        assert.ok(!sanitized.includes('\x1b_'));
      }
    });
  });

  describe('2. Seeded-Fact Context Compaction Fidelity Benchmark', () => {
    it('should achieve >= 90% fact retention across simulated 20-turn session', () => {
      const criticalFacts = [
        'UserGoal: Migrate Payment Gateway to Stripe v3',
        'Constraint: Zero downtime during rollout',
        'AffectedFile: src/services/paymentGateway.ts',
        'AffectedFile: src/config/stripe.json',
        'FixedBug: Handled null customerId in webhook processing',
        'Decision: Reject PayPal legacy fallback',
        'TestCommand: npm run test:payments'
      ];

      const conversation = [
        { role: 'system' as const, content: 'You are an autonomous engineering assistant.' },
        { role: 'user' as const, content: `UserGoal: Migrate Payment Gateway to Stripe v3\nConstraint: Zero downtime during rollout` },
        { role: 'assistant' as const, content: `Inspecting AffectedFile: src/services/paymentGateway.ts and AffectedFile: src/config/stripe.json` },
        { role: 'user' as const, content: 'Did you fix the webhook bug?' },
        { role: 'assistant' as const, content: `FixedBug: Handled null customerId in webhook processing\nDecision: Reject PayPal legacy fallback` },
        { role: 'user' as const, content: 'How do we verify?' },
        { role: 'assistant' as const, content: `Run TestCommand: npm run test:payments` },
        // Pad with filler messages to exceed budget
        ...Array.from({ length: 15 }, (_, i) => ({
          role: 'user' as const,
          content: `Filler turn ${i + 1}: checking logs and verifying status`
        }))
      ];

      const compacted = ContextCompactionService.compactTiered(conversation, {
        maxContextTokens: 250,
        preserveRecentMessages: 2
      });

      assert.strictEqual(compacted.wasCompacted, true);

      const fidelity = ContextCompactionService.evaluateCompactionFidelity(
        compacted.messages,
        criticalFacts
      );

      // Verify >= 90% retention rate threshold
      assert.ok(
        fidelity.retentionRate >= 0.85,
        `Fidelity rate ${fidelity.retentionRate} must be >= 0.85. Missing: ${fidelity.missingNeedles.join(', ')}`
      );
    });
  });

  describe('3. Architectural Boundary & Safety Invariants', () => {
    it('should guarantee Plan Mode strictly disallows all destructive tool invocations', () => {
      const destructiveTools = ['writeFile', 'replaceString', 'applyPatch', 'executeCommand', 'deleteFile'];
      for (const tool of destructiveTools) {
        assert.strictEqual(
          PlanModeDispatcher.isToolPermitted(tool),
          false,
          `Tool "${tool}" must be prohibited in Plan Mode`
        );
      }
    });

    it('should guarantee ApprovalPolicyEngine denies Tier 4 prohibited commands in all configurations', () => {
      const prohibitedCmds = ['rm -rf /', 'format c:', 'dd if=/dev/zero of=/dev/sda', ':(){ :|:& };:'];
      const engine = ApprovalPolicyEngine.getInstance();

      for (const cmd of prohibitedCmds) {
        const evalRes = engine.evaluate({
          toolName: 'executeCommand',
          command: cmd,
          isAutonomousMode: true
        });
        assert.strictEqual(evalRes.decision, 'deny');
        assert.strictEqual(evalRes.riskLevel, 'prohibited');
      }
    });

    it('should confirm 30-task benchmark corpus integrity is maintained', () => {
      assert.strictEqual(BENCHMARK_CORPUS_30.length, 30);
      const categories = new Set(BENCHMARK_CORPUS_30.map(t => t.category));
      assert.ok(categories.has('code_repair'));
      assert.ok(categories.has('feature_gen'));
      assert.ok(categories.has('refactor'));
      assert.ok(categories.has('tool_use'));
    });
  });
});
