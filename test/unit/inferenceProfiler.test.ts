import * as assert from 'assert';
import { InferenceProfiler } from '../../src/services/inferenceProfiler';

describe('Deliverable 12.5: Local Inference Performance & Overhead Suite', () => {
  describe('Turn Overhead Calculation', () => {
    it('should confirm acceptable overhead when extension processing is under 5%', () => {
      const profile = InferenceProfiler.profileTurn({
        turnId: 'turn_01',
        modelTag: 'qwen2.5-coder:7b',
        totalTurnDurationMs: 5000,
        ollamaInferenceDurationMs: 4850, // 150ms overhead = 3%
        evalTokensCount: 150,
        promptTokensCount: 200,
        baselineTps: 30.0
      });

      assert.strictEqual(profile.extensionOverheadMs, 150);
      assert.strictEqual(profile.overheadPercentage, 3.0);
      assert.strictEqual(profile.isOverheadAcceptable, true);
      assert.strictEqual(profile.tokensPerSecond, 30.9);
      assert.strictEqual(profile.isThrottled, false);

      const summary = InferenceProfiler.formatProfileSummary(profile);
      assert.ok(summary.includes('Extension Overhead: 150ms (3%)'));
    });

    it('should flag unacceptable overhead when extension processing exceeds 5%', () => {
      const profile = InferenceProfiler.profileTurn({
        turnId: 'turn_02',
        modelTag: 'qwen2.5-coder:7b',
        totalTurnDurationMs: 2000,
        ollamaInferenceDurationMs: 1700, // 300ms overhead = 15%
        evalTokensCount: 50,
        promptTokensCount: 100
      });

      assert.strictEqual(profile.extensionOverheadMs, 300);
      assert.strictEqual(profile.overheadPercentage, 15.0);
      assert.strictEqual(profile.isOverheadAcceptable, false);
    });

    it('should detect throughput throttling when TPS drops below 50% of baseline', () => {
      const profile = InferenceProfiler.profileTurn({
        turnId: 'turn_03',
        modelTag: 'qwen2.5-coder:7b',
        totalTurnDurationMs: 5000,
        ollamaInferenceDurationMs: 4900,
        evalTokensCount: 50, // 50 tokens in 4.9s = ~10.2 tok/s
        promptTokensCount: 150,
        baselineTps: 32.0 // baseline is 32 tok/s, 10.2 < 16.0 (50%)
      });

      assert.strictEqual(profile.isThrottled, true);
      assert.ok(profile.warningMessage?.includes('dropped to 10.2 tok/s'));
      assert.ok(profile.warningMessage?.includes('< 50% of 32 tok/s baseline'));
    });
  });
});
