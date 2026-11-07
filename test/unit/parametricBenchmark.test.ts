import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ParametricBenchmarkHarness,
  ParametricBenchmarkConfig,
  ParametricBenchmarkResult,
  FailureTaxonomyType
} from '../../src/services/parametricBenchmarkHarness';
import { BenchmarkTask } from '../../src/services/evaluationService';
import { OllamaService, OllamaChatMetadata } from '../../src/services/ollamaService';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 12.1: Model-Parametric Benchmark Harness Suite', () => {
  let mockOllamaService: any;
  let harness: ParametricBenchmarkHarness;
  const tempDir = 'C:\\Projects\\test-workspace';

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'bench-workspace', uri: MockUri.file(tempDir), index: 0 }
    ]);

    mockOllamaService = {
      streamChat: async (
        model: string,
        messages: any[],
        onChunk: (chunk: string) => void,
        signal?: any,
        options?: any,
        timeouts?: any,
        onMetadata?: (meta: OllamaChatMetadata) => void
      ): Promise<string> => {
        const prompt = messages[messages.length - 1].content;
        let response = '';

        if (prompt.includes('getUserName')) {
          response = 'function getUserName(user) { return user?.name ?? "Guest"; }';
        } else if (prompt.includes('sumArray')) {
          response = 'function sumArray(nums: number[]): number {\n  let total = 0;\n  for (let i = 0; i < nums.length; i++) { total += nums[i]; }\n  return total;\n}';
        } else if (prompt.includes('failMe')) {
          response = 'broken code without target token';
        } else if (prompt.includes('throwError')) {
          throw new Error('Connection refused ECONNREFUSED on port 11434');
        } else {
          response = 'export function example() { return 42; }';
        }

        // Simulate streaming chunks
        const chunks = response.split(' ');
        for (const c of chunks) {
          onChunk(c + ' ');
        }

        // Emit metadata
        if (onMetadata) {
          onMetadata({
            prompt_eval_count: 50,
            prompt_eval_duration: 1_000_000_000, // 1s => 50 t/s
            eval_count: 20,
            eval_duration: 500_000_000, // 0.5s => 40 t/s
            total_duration: 1_500_000_000
          });
        }

        return response;
      }
    };

    harness = new ParametricBenchmarkHarness(mockOllamaService as unknown as OllamaService);
  });

  describe('Failure Taxonomy Classifier', () => {
    it('should classify timeout failures accurately', () => {
      const type = ParametricBenchmarkHarness.classifyFailure('Task execution timed out after 30000ms');
      assert.strictEqual(type, 'timeout');
    });

    it('should classify crashes, VRAM out-of-memory, and socket drops accurately', () => {
      assert.strictEqual(ParametricBenchmarkHarness.classifyFailure('fetch failed ECONNREFUSED'), 'crash');
      assert.strictEqual(ParametricBenchmarkHarness.classifyFailure('Ollama failed to allocate VRAM'), 'crash');
      assert.strictEqual(ParametricBenchmarkHarness.classifyFailure('HTTP 500 Internal Server Error'), 'crash');
    });

    it('should classify context overflow and truncated output', () => {
      const truncatedOutput = 'function foo() { ' + 'x'.repeat(2500) + '...';
      assert.strictEqual(ParametricBenchmarkHarness.classifyFailure(undefined, truncatedOutput), 'context_overflow');
      assert.strictEqual(ParametricBenchmarkHarness.classifyFailure('num_ctx exceeded token limit'), 'context_overflow');
    });

    it('should classify hallucinated imports', () => {
      const type = ParametricBenchmarkHarness.classifyFailure('Cannot find module "nonexistent-pkg"');
      assert.strictEqual(type, 'hallucinated_import');
    });

    it('should classify syntax errors', () => {
      const type = ParametricBenchmarkHarness.classifyFailure('SyntaxError: Unexpected token <');
      assert.strictEqual(type, 'syntax_error');
    });

    it('should default to test_failure for assertion mismatch', () => {
      const type = ParametricBenchmarkHarness.classifyFailure('Output missing required tokens');
      assert.strictEqual(type, 'test_failure');
    });
  });

  describe('Task Output Verification', () => {
    const task: BenchmarkTask = {
      id: 'test-01',
      name: 'Test Task',
      category: 'code_repair',
      prompt: 'Fix it',
      expectedOutputs: {
        mustContain: ['user?.name', '?? "Guest"'],
        mustNotContain: ['undefined']
      }
    };

    it('should verify passing output that satisfies all constraints', () => {
      const res = ParametricBenchmarkHarness.verifyTaskOutput(
        task,
        'function getUserName(user) { return user?.name ?? "Guest"; }'
      );
      assert.strictEqual(res.passed, true);
      assert.strictEqual(res.error, undefined);
    });

    it('should fail when missing required mustContain token', () => {
      const res = ParametricBenchmarkHarness.verifyTaskOutput(
        task,
        'function getUserName(user) { return user.name; }'
      );
      assert.strictEqual(res.passed, false);
      assert.ok(res.error?.includes('missing required tokens'));
    });

    it('should fail when containing prohibited mustNotContain token', () => {
      const res = ParametricBenchmarkHarness.verifyTaskOutput(
        task,
        'return user?.name ?? "Guest" ?? undefined;'
      );
      assert.strictEqual(res.passed, false);
      assert.ok(res.error?.includes('contains prohibited token'));
    });

    it('should reject empty or whitespace-only output', () => {
      const res = ParametricBenchmarkHarness.verifyTaskOutput(task, '   ');
      assert.strictEqual(res.passed, false);
      assert.ok(res.error?.includes('Empty output'));
    });
  });

  describe('Parametric Benchmark Execution & Throughput Tracking', () => {
    it('should run benchmark across tasks with N=3 repetitions and cold/warm separation', async () => {
      const customTasks: BenchmarkTask[] = [
        {
          id: 'test-pass',
          name: 'Passing Task',
          category: 'code_repair',
          prompt: 'Fix getUserName',
          expectedOutputs: { mustContain: ['user?.name'] }
        },
        {
          id: 'test-fail',
          name: 'Failing Task',
          category: 'feature_gen',
          prompt: 'Please failMe',
          expectedOutputs: { mustContain: ['nonexistent_token'] }
        }
      ];

      const progressEvents: string[] = [];
      const config: ParametricBenchmarkConfig = {
        model: 'qwen2.5-coder:7b',
        numCtx: 8192,
        temperature: 0,
        runs: 3
      };

      const result: ParametricBenchmarkResult = await harness.runBenchmark(config, {
        customCorpus: customTasks,
        onProgress: (done, total, name) => {
          progressEvents.push(`${done}/${total}: ${name}`);
        }
      });

      assert.strictEqual(result.schemaVersion, '1.0.0');
      assert.strictEqual(result.totalTasks, 2);
      assert.strictEqual(result.passedTasks, 1);
      assert.strictEqual(result.overallPassRate, 0.5);

      // Verify category breakdown
      assert.strictEqual(result.categoryBreakdown.code_repair.passed, 1);
      assert.strictEqual(result.categoryBreakdown.feature_gen.passed, 0);

      // Verify failure taxonomy recorded test_failure
      assert.ok(result.failureTaxonomy.test_failure >= 1);

      // Verify progress callback executed
      assert.strictEqual(progressEvents.length, 2);

      // Verify runs per task: 3 runs each
      const passTaskResult = result.tasks.find(t => t.taskId === 'test-pass');
      assert.ok(passTaskResult);
      assert.strictEqual(passTaskResult.runs.length, 3);
      assert.strictEqual(passTaskResult.runs[0].isCold, true);
      assert.strictEqual(passTaskResult.runs[1].isWarm, true);
      assert.strictEqual(passTaskResult.runs[2].isWarm, true);

      // Verify throughput recorded: ~40 t/s generation, ~50 t/s prompt eval
      assert.ok(result.throughputStats.generationTokensPerSec.mean >= 30);
      assert.ok(result.throughputStats.promptEvalTokensPerSec.mean >= 40);
    });

    it('should handle runtime crashes and classify into crash taxonomy', async () => {
      const crashTasks: BenchmarkTask[] = [
        {
          id: 'test-crash',
          name: 'Crash Task',
          category: 'tool_use',
          prompt: 'Please throwError',
          expectedOutputs: { mustContain: ['anything'] }
        }
      ];

      const result = await harness.runBenchmark(
        { model: 'qwen2.5-coder:7b', runs: 1 },
        { customCorpus: crashTasks }
      );

      assert.strictEqual(result.passedTasks, 0);
      assert.strictEqual(result.failureTaxonomy.crash, 1);
      assert.strictEqual(result.tasks[0].dominantFailureType, 'crash');
    });

    it('should respect cancellation signal gracefully', async () => {
      const tasks: BenchmarkTask[] = [
        { id: 't1', name: 'Task 1', category: 'code_repair', prompt: 'getUserName' },
        { id: 't2', name: 'Task 2', category: 'code_repair', prompt: 'getUserName' }
      ];

      const cancelSignal = { aborted: true };
      const result = await harness.runBenchmark(
        { model: 'qwen2.5-coder:7b', runs: 1 },
        { customCorpus: tasks, cancelSignal }
      );

      assert.strictEqual(result.tasks.length, 0);
    });
  });

  describe('Markdown Report Synthesis & Persistence', () => {
    it('should generate structured markdown report with all required sections', async () => {
      const customTasks: BenchmarkTask[] = [
        {
          id: 'repair-01',
          name: 'Null Reference Repair',
          category: 'code_repair',
          prompt: 'Fix getUserName',
          expectedOutputs: { mustContain: ['user?.name'] }
        }
      ];

      const result = await harness.runBenchmark(
        { model: 'qwen2.5-coder:7b', numCtx: 8192, runs: 2 },
        { customCorpus: customTasks }
      );

      const markdown = ParametricBenchmarkHarness.generateMarkdownReport(result);

      // Check required sections
      assert.ok(markdown.includes('# Benchmark Run Report: `qwen2.5-coder:7b`'));
      assert.ok(markdown.includes('## 1. Hardware & Environment Fingerprint'));
      assert.ok(markdown.includes('## 2. Benchmark Parameters'));
      assert.ok(markdown.includes('## 3. Executive Performance Summary'));
      assert.ok(markdown.includes('## 4. Category Score Matrix'));
      assert.ok(markdown.includes('## 5. Failure Taxonomy Breakdown'));
      assert.ok(markdown.includes('## 6. Detailed Task-by-Task Results'));
      assert.ok(markdown.includes('Overall Pass Rate'));
      assert.ok(markdown.includes('Generation Throughput'));
    });

    it('should atomically save result to JSON', async () => {
      const customTasks: BenchmarkTask[] = [
        { id: 'save-test', name: 'Save Task', category: 'refactor', prompt: 'getUserName' }
      ];

      const result = await harness.runBenchmark(
        { model: 'qwen2.5-coder:7b', runs: 1 },
        { customCorpus: customTasks }
      );

      const savedPath = await harness.saveResult(result, tempDir);
      assert.ok(savedPath.endsWith('.json'));

      // Verify file read back through VS Code mock fs
      const contentBytes = await vscode.workspace.fs.readFile(MockUri.file(savedPath));
      const parsed = JSON.parse(Buffer.from(contentBytes).toString('utf-8'));
      assert.strictEqual(parsed.schemaVersion, '1.0.0');
      assert.strictEqual(parsed.runId, result.runId);
      assert.strictEqual(parsed.config.model, 'qwen2.5-coder:7b');
    });
  });
});
