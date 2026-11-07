import * as assert from 'assert';
import { SubagentDelegationProtocol } from '../../src/services/subagentDelegationProtocol';
import { HardwareCapacityManager } from '../../src/services/hardwareCapacityManager';

describe('Phase 10.5: Reliable Sub-Agent Delegation & Protocol Suite', () => {
  let delegation: SubagentDelegationProtocol;

  beforeEach(() => {
    HardwareCapacityManager.resetInstance();
    delegation = new SubagentDelegationProtocol();
  });

  it('should successfully delegate task to subagent and record history', async () => {
    const result = await delegation.delegate(
      {
        from: 'orchestrator',
        to: 'architect',
        task: 'Define architecture for logging'
      },
      async (prompt, attempt) => {
        assert.ok(prompt.includes('Task for architect'));
        assert.strictEqual(attempt, 1);
        return '{"role": "architect", "architecturePlan": ["step1"]}';
      }
    );

    assert.ok(result.includes('step1'));
    const history = delegation.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].status, 'completed');
    assert.strictEqual(history[0].attempts, 1);
  });

  it('should retry with corrective prompt on initial failure and succeed', async () => {
    let callCount = 0;
    const result = await delegation.delegate(
      {
        from: 'orchestrator',
        to: 'developer',
        task: 'Write patch',
        maxRetries: 2
      },
      async (prompt, attempt) => {
        callCount++;
        if (attempt === 1) {
          throw new Error('Malformed JSON syntax');
        }
        assert.ok(prompt.includes('Previous attempt failed with error: Malformed JSON syntax'));
        return '{"role": "developer", "patches": []}';
      }
    );

    assert.strictEqual(callCount, 2);
    assert.ok(result.includes('"role": "developer"'));
    const history = delegation.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].attempts, 2);
    assert.strictEqual(history[0].status, 'completed');
  });

  it('should abort and fail when subagent execution exceeds timeout', async () => {
    await assert.rejects(
      async () => {
        await delegation.delegate(
          {
            from: 'orchestrator',
            to: 'tester',
            task: 'Run slow tests',
            timeoutMs: 30, // 30ms timeout
            maxRetries: 1
          },
          async () => {
            await new Promise(r => setTimeout(r, 100)); // Deliberate delay
            return 'should have timed out';
          }
        );
      },
      /timed out/
    );

    const history = delegation.getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].status, 'timed_out');
  });
});
