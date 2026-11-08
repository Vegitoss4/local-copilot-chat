import * as assert from 'assert';
import { QuantizationEvaluator, ModelQuantCandidate } from '../../src/services/quantizationEvaluator';

describe('Deliverable 12.2: Quantization Evaluation & Pareto Frontier Suite', () => {
  describe('Quantization Tag Parsing', () => {
    it('should parse quantization tags correctly from varied model naming patterns', () => {
      assert.strictEqual(QuantizationEvaluator.parseQuantization('qwen2.5-coder:7b-instruct-q4_K_M'), 'Q4_K_M');
      assert.strictEqual(QuantizationEvaluator.parseQuantization('deepseek-r1:8b-q8_0'), 'Q8_0');
      assert.strictEqual(QuantizationEvaluator.parseQuantization('mistral:7b-instruct-fp16'), 'FP16');
      assert.strictEqual(QuantizationEvaluator.parseQuantization('custom-model:latest'), 'Q4_K_M (Default)');
    });
  });

  describe('Pareto Frontier Optimization', () => {
    it('should identify non-dominated Pareto optimal models under 8 GB VRAM budget', async () => {
      const candidates: ModelQuantCandidate[] = [
        {
          modelTag: 'qwen2.5-coder:7b-q4_K_M',
          baseModel: 'qwen2.5-coder',
          quantization: 'Q4_K_M',
          sizeBytes: 4.7 * 1024 * 1024 * 1024,
          sizeGb: 4.7,
          vramGb: 4.7,
          measuredTps: 34.5,
          qualityScore: 82.0
        },
        {
          modelTag: 'qwen2.5-coder:7b-q8_0',
          baseModel: 'qwen2.5-coder',
          quantization: 'Q8_0',
          sizeBytes: 7.9 * 1024 * 1024 * 1024,
          sizeGb: 7.9,
          vramGb: 7.9,
          measuredTps: 18.2,
          qualityScore: 85.5
        },
        {
          // Dominated by q4_K_M (slower and lower quality)
          modelTag: 'qwen2.5-coder:7b-q3_K_S',
          baseModel: 'qwen2.5-coder',
          quantization: 'Q3_K_S',
          sizeBytes: 4.9 * 1024 * 1024 * 1024,
          sizeGb: 4.9,
          vramGb: 4.9,
          measuredTps: 20.0,
          qualityScore: 71.0
        },
        {
          // Exceeds 8 GB budget -> filtered out
          modelTag: 'qwen2.5-coder:14b-q8_0',
          baseModel: 'qwen2.5-coder',
          quantization: 'Q8_0',
          sizeBytes: 15.0 * 1024 * 1024 * 1024,
          sizeGb: 15.0,
          vramGb: 15.0,
          measuredTps: 6.0,
          qualityScore: 92.0
        }
      ];

      const result = await QuantizationEvaluator.computeParetoFrontier(candidates, 8.0, {
        gpuName: 'NVIDIA GeForce RTX 3070 Ti',
        driverVersion: '560.94',
        totalVramBytes: 8192 * 1024 * 1024,
        freeVramBytes: 6144 * 1024 * 1024,
        cpuModel: 'Intel Core i7-12700K',
        logicalCores: 20,
        cpuArch: 'x64',
        totalRamBytes: 32 * 1024 * 1024 * 1024,
        freeRamBytes: 16 * 1024 * 1024 * 1024,
        osPlatform: 'win32',
        osRelease: '10.0.22631',
        ollamaVersion: '0.40.7',
        nodeVersion: 'v20.11.0',
        vscodeVersion: '1.85.0',
        timestamp: new Date().toISOString()
      });

      assert.strictEqual(result.vramBudgetGb, 8.0);
      assert.ok(result.paretoFrontier.length > 0);

      // Verify q4_K_M and q8_0 are on Pareto frontier
      const paretoTags = result.paretoFrontier.map(p => p.modelTag);
      assert.ok(paretoTags.includes('qwen2.5-coder:7b-q4_K_M'));
      assert.ok(paretoTags.includes('qwen2.5-coder:7b-q8_0'));

      // Verify dominated q3_K_S and over-budget 14b are excluded from frontier
      assert.ok(!paretoTags.includes('qwen2.5-coder:7b-q3_K_S'));
      assert.ok(!paretoTags.includes('qwen2.5-coder:14b-q8_0'));

      // Verify markdown table formatting
      const table = QuantizationEvaluator.formatParetoTable(result);
      assert.ok(table.includes('Model Quantization & Pareto Frontier Analysis'));
      assert.ok(table.includes('qwen2.5-coder:7b-q4_K_M'));
    });
  });
});
