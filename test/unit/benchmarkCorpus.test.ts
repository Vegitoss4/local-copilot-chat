import * as assert from 'assert';
import { BENCHMARK_CORPUS_30, compareBenchmarkRuns } from '../../src/services/benchmarkTaskCorpus';
import { EvaluationService, BenchmarkSuiteResult } from '../../src/services/evaluationService';
import { OllamaService } from '../../src/services/ollamaService';

describe('Phase 9.0: Benchmark Task Corpus (30 Tasks) & Measurement Harness Suite', () => {
  let ollamaService: OllamaService;
  let evalService: EvaluationService;

  beforeEach(() => {
    ollamaService = new OllamaService();
    evalService = new EvaluationService(ollamaService);
  });

  it('should define exactly 30 diverse benchmark tasks across 4 categories', () => {
    const tasks = evalService.getCorpus30Tasks();
    assert.strictEqual(tasks.length, 30);

    const categories = {
      code_repair: tasks.filter(t => t.category === 'code_repair').length,
      feature_gen: tasks.filter(t => t.category === 'feature_gen').length,
      refactor: tasks.filter(t => t.category === 'refactor').length,
      tool_use: tasks.filter(t => t.category === 'tool_use').length
    };

    assert.strictEqual(categories.code_repair, 10, 'Must have 10 code repair tasks');
    assert.strictEqual(categories.feature_gen, 8, 'Must have 8 feature generation tasks');
    assert.strictEqual(categories.refactor, 6, 'Must have 6 refactor tasks');
    assert.strictEqual(categories.tool_use, 6, 'Must have 6 tool use tasks');
  });

  it('should enforce unique task IDs and valid expectedOutputs across all tasks', () => {
    const tasks = BENCHMARK_CORPUS_30;
    const seenIds = new Set<string>();

    for (const task of tasks) {
      assert.ok(task.id, 'Task ID must be non-empty');
      assert.ok(!seenIds.has(task.id), `Duplicate task ID: ${task.id}`);
      seenIds.add(task.id);

      assert.ok(task.name && task.name.length > 5, `Task ${task.id} must have descriptive name`);
      assert.ok(task.prompt && task.prompt.length > 10, `Task ${task.id} must have substantial prompt`);
      assert.ok(task.expectedOutputs, `Task ${task.id} must define expectedOutputs`);
      assert.ok(
        (task.expectedOutputs.mustContain && task.expectedOutputs.mustContain.length > 0) ||
        (task.expectedOutputs.fileMatches && Object.keys(task.expectedOutputs.fileMatches).length > 0),
        `Task ${task.id} must have at least one mustContain pattern or fileMatch`
      );
    }
  });

  it('should compare baseline and candidate benchmark results with category deltas', () => {
    const baselineResult: BenchmarkSuiteResult = {
      runId: 'baseline-001',
      timestamp: new Date().toISOString(),
      model: 'qwen2.5-coder:7b',
      totalTasks: 30,
      passedTasks: 18,
      taskCompletionRate: 0.60,
      categoryScores: {
        code_repair: { total: 10, passed: 6, passRate: 0.60 },
        feature_gen: { total: 8, passed: 5, passRate: 0.625 },
        refactor: { total: 6, passed: 4, passRate: 0.667 },
        tool_use: { total: 6, passed: 3, passRate: 0.50 }
      },
      totalDurationMs: 45000,
      results: []
    };

    const candidateResult: BenchmarkSuiteResult = {
      runId: 'candidate-002',
      timestamp: new Date().toISOString(),
      model: 'qwen2.5-coder:7b',
      totalTasks: 30,
      passedTasks: 24,
      taskCompletionRate: 0.80,
      categoryScores: {
        code_repair: { total: 10, passed: 8, passRate: 0.80 },
        feature_gen: { total: 8, passed: 7, passRate: 0.875 },
        refactor: { total: 6, passed: 5, passRate: 0.833 },
        tool_use: { total: 6, passed: 4, passRate: 0.667 }
      },
      totalDurationMs: 42000,
      results: []
    };

    const comparison = evalService.compareRuns(baselineResult, candidateResult);
    assert.strictEqual(comparison.baselinePassRate, 0.60);
    assert.strictEqual(comparison.candidatePassRate, 0.80);
    assert.strictEqual(comparison.deltaPassRate, 0.20);
    assert.strictEqual(comparison.categoryDeltas['code_repair'].delta, 0.20);
    assert.strictEqual(comparison.categoryDeltas['feature_gen'].delta, 0.25);
    assert.strictEqual(comparison.durationDeltaMs, -3000);
  });
});
