import * as assert from 'assert';
import { HardwareCapacityManager } from '../../src/services/hardwareCapacityManager';

describe('Phase 10.0: Hardware Capacity Budget & Multi-Agent Planning Suite', () => {
  let capacityManager: HardwareCapacityManager;

  beforeEach(() => {
    HardwareCapacityManager.resetInstance();
    capacityManager = HardwareCapacityManager.getInstance();
  });

  it('should initialize with 8 GB VRAM budget and single-model residency enforced', () => {
    const config = capacityManager.getConfig();
    assert.strictEqual(config.maxVramBytes, 8 * 1024 * 1024 * 1024);
    assert.strictEqual(config.singleModelResidencyEnforced, true);
    assert.strictEqual(config.maxConcurrentToolTasks, 2);
  });

  it('should strictly serialize multiple competing LLM inference turns', async () => {
    const executionOrder: string[] = [];

    const turn1 = capacityManager.enqueueInferenceTurn('qwen2.5-coder:7b', async () => {
      executionOrder.push('start-turn1');
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push('end-turn1');
      return 'res1';
    });

    const turn2 = capacityManager.enqueueInferenceTurn('qwen2.5-coder:7b', async () => {
      executionOrder.push('start-turn2');
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push('end-turn2');
      return 'res2';
    });

    const turn3 = capacityManager.enqueueInferenceTurn('deepseek-r1:8b', async () => {
      executionOrder.push('start-turn3');
      await new Promise(r => setTimeout(r, 5));
      executionOrder.push('end-turn3');
      return 'res3';
    });

    const [r1, r2, r3] = await Promise.all([turn1, turn2, turn3]);
    assert.strictEqual(r1, 'res1');
    assert.strictEqual(r2, 'res2');
    assert.strictEqual(r3, 'res3');

    // Verify non-overlapping sequential execution
    assert.deepStrictEqual(executionOrder, [
      'start-turn1',
      'end-turn1',
      'start-turn2',
      'end-turn2',
      'start-turn3',
      'end-turn3'
    ]);

    const stats = capacityManager.getStats();
    assert.strictEqual(stats.totalCompletedTurns, 3);
    assert.strictEqual(stats.queuedCount, 0);
  });

  it('should track and throttle concurrent background tool tasks', () => {
    assert.strictEqual(capacityManager.canScheduleToolTask(), true);
    assert.strictEqual(capacityManager.acquireToolSlot(), true);
    assert.strictEqual(capacityManager.acquireToolSlot(), true);

    // Default limit is 2; third acquisition should be denied
    assert.strictEqual(capacityManager.canScheduleToolTask(), false);
    assert.strictEqual(capacityManager.acquireToolSlot(), false);

    capacityManager.releaseToolSlot();
    assert.strictEqual(capacityManager.canScheduleToolTask(), true);
    assert.strictEqual(capacityManager.acquireToolSlot(), true);
  });
});
