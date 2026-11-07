import * as assert from 'assert';
import { SubagentTaskPool, PoolTask } from '../../src/services/subagentTaskPool';

describe('Phase 10.2: Parallel Sub-Agent Execution with Concurrency Controls Suite', () => {
  it('should execute tasks respecting max concurrency cap', async () => {
    const pool = new SubagentTaskPool(2);
    let peakConcurrency = 0;
    let currentRunning = 0;

    const makeTask = (id: string): PoolTask<string> => ({
      id,
      name: `Task-${id}`,
      priority: 'normal',
      execute: async () => {
        currentRunning++;
        if (currentRunning > peakConcurrency) {
          peakConcurrency = currentRunning;
        }
        await new Promise(r => setTimeout(r, 25));
        currentRunning--;
        return `done-${id}`;
      }
    });

    const tasks = [makeTask('1'), makeTask('2'), makeTask('3'), makeTask('4')];
    const results = await Promise.all(tasks.map(t => pool.submit(t)));

    assert.deepStrictEqual(results, ['done-1', 'done-2', 'done-3', 'done-4']);
    assert.strictEqual(peakConcurrency, 2, 'Must never exceed max concurrency cap of 2');

    const stats = pool.getStats();
    assert.strictEqual(stats.completedCount, 4);
    assert.strictEqual(stats.activeCount, 0);
  });

  it('should prioritize high priority tasks over normal and low', async () => {
    const pool = new SubagentTaskPool(1);
    const executionOrder: string[] = [];

    // Block the single slot briefly
    const blocker = pool.submit({
      id: 'blocker',
      name: 'Blocker',
      priority: 'normal',
      execute: async () => {
        await new Promise(r => setTimeout(r, 30));
        executionOrder.push('blocker');
      }
    });

    // Queue low, normal, and high while blocker is running
    const low = pool.submit({
      id: 'low-1',
      name: 'Low Task',
      priority: 'low',
      execute: async () => { executionOrder.push('low'); }
    });

    const normal = pool.submit({
      id: 'normal-1',
      name: 'Normal Task',
      priority: 'normal',
      execute: async () => { executionOrder.push('normal'); }
    });

    const high = pool.submit({
      id: 'high-1',
      name: 'High Task',
      priority: 'high',
      execute: async () => { executionOrder.push('high'); }
    });

    await Promise.all([blocker, low, normal, high]);

    // High must run before normal, which runs before low
    assert.deepStrictEqual(executionOrder, ['blocker', 'high', 'normal', 'low']);
  });

  it('should cancel tasks when abort signal is triggered', async () => {
    const pool = new SubagentTaskPool(1);
    const controller = new AbortController();

    const blocker = pool.submit({
      id: 'blocker',
      name: 'Blocker',
      priority: 'normal',
      execute: async () => { await new Promise(r => setTimeout(r, 20)); }
    });

    const abortedTask = pool.submit({
      id: 'will-abort',
      name: 'Will Abort',
      priority: 'normal',
      signal: controller.signal,
      execute: async () => 'should not run'
    });

    controller.abort();

    await blocker;
    await assert.rejects(
      async () => { await abortedTask; },
      /aborted/
    );
  });
});
