import * as assert from 'assert';
import { BenchmarkReportGenerator } from '../../src/services/benchmarkReportGenerator';
import { ParametricBenchmarkResult } from '../../src/services/parametricBenchmarkHarness';
import { ContextOptimizationService } from '../../src/services/contextOptimizationService';
import { ModelRouter, ModelProfile } from '../../src/services/modelRouter';
import { QuantizationEvaluator } from '../../src/services/quantizationEvaluator';

describe('Phase 12: Model Intelligence & Optimization Verification Suite', () => {
  describe('1. Multi-Model Benchmark Report Synthesis', () => {
    it('should generate comprehensive markdown report from parametric benchmark outputs', () => {
      const mockResult: ParametricBenchmarkResult = {
        schemaVersion: '1.0.0',
        runId: 'bench_run_01',
        timestamp: new Date().toISOString(),
        hardwareFingerprint: {
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
        },
        config: {
          model: 'qwen2.5-coder:7b',
          numCtx: 8192,
          temperature: 0.0,
          seed: 42,
          runs: 3,
          timeoutMs: 45000
        },
        totalTasks: 30,
        passedTasks: 28,
        overallPassRate: 0.933,
        categoryBreakdown: {
          code_repair: { total: 10, passed: 10, passRate: 1.0 },
          feature_gen: { total: 8, passed: 7, passRate: 0.875 },
          refactor: { total: 7, passed: 6, passRate: 0.857 },
          tool_use: { total: 5, passed: 5, passRate: 1.0 }
        },
        throughputStats: {
          generationTokensPerSec: { runs: 3, mean: 34.5, stdDev: 1.2, min: 33.1, max: 35.5, p50: 34.5, p95: 35.4 },
          promptEvalTokensPerSec: { runs: 3, mean: 210.0, stdDev: 8.5, min: 201.0, max: 218.0, p50: 210.0, p95: 217.2 },
          timeToFirstTokenMs: { runs: 3, mean: 450, stdDev: 30, min: 420, max: 480, p50: 450, p95: 477 },
          coldTtftMs: 3800
        },
        failureTaxonomy: {
          syntax_error: 0,
          test_failure: 1,
          hallucinated_import: 1,
          context_overflow: 0,
          timeout: 0,
          crash: 0
        },
        tasks: []
      };

      const md = BenchmarkReportGenerator.generateMultiModelReport([mockResult]);

      assert.ok(md.includes('# PHASE 12 MODEL INTELLIGENCE BENCHMARK RESULTS'));
      assert.ok(md.includes('NVIDIA GeForce RTX 3070 Ti'));
      assert.ok(md.includes('qwen2.5-coder:7b'));
      assert.ok(md.includes('93% (28/30)'));
      assert.ok(md.includes('34.5 ± 1.2'));
      assert.ok(md.includes('code_repair'));
      assert.ok(md.includes('test_failure'));
      assert.ok(md.includes('Sample Variance & Statistical Significance'));
    });
  });

  describe('2. Single-Model GPU Residency & 8 GB VRAM Constraints', () => {
    it('should recommend 8192 context limit to prevent VRAM overflow and CPU spillover', () => {
      const rec = ContextOptimizationService.recommendContextSize(4.8 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024);
      assert.strictEqual(rec, 8192);
    });

    it('should calculate Pareto optimality correctly across quantizations', async () => {
      const candidates = [
        { modelTag: 'model:q4', baseModel: 'model', quantization: 'Q4', sizeBytes: 4e9, sizeGb: 4.0, measuredTps: 35, qualityScore: 80 },
        { modelTag: 'model:q8', baseModel: 'model', quantization: 'Q8', sizeBytes: 7.5e9, sizeGb: 7.5, measuredTps: 20, qualityScore: 85 }
      ];

      const res = await QuantizationEvaluator.computeParetoFrontier(candidates, 8.0, {
        gpuName: 'RTX 3070 Ti', driverVersion: '560', totalVramBytes: 8e9, freeVramBytes: 6e9,
        cpuModel: 'i7', logicalCores: 8, cpuArch: 'x64', totalRamBytes: 32e9, freeRamBytes: 16e9,
        osPlatform: 'win32', osRelease: '11', ollamaVersion: '0.40', nodeVersion: '20', vscodeVersion: '1.85', timestamp: ''
      });

      assert.strictEqual(res.paretoFrontier.length, 2);
    });
  });

  describe('3. Swap-Cost Aware Routing Invariants', () => {
    it('should respect user model override and preserve single-model residency', () => {
      const profiles = new Map<string, ModelProfile>();
      profiles.set('resident:7b', {
        modelTag: 'resident:7b', measuredTps: 30, vramBytes: 4.8e9, effectiveContextTokens: 8192,
        toolCallReliability: 0.9, categoryStrengths: { reasoning: 70 }, swapCostMs: 3500
      });

      const dec = ModelRouter.evaluateRouteWithProfiles({
        prompt: 'Hello',
        currentResidentModel: 'resident:7b',
        availableModels: ['resident:7b'],
        profiles,
        isRouterEnabled: true,
        swapThresholdPercent: 15
      });

      assert.strictEqual(dec.model, 'resident:7b');
      assert.strictEqual(dec.isSwapRecommended, false);
    });
  });
});
