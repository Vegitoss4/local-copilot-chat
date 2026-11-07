import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaService, OllamaChatMetadata } from './ollamaService';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';
import { BENCHMARK_CORPUS_30 } from './benchmarkTaskCorpus';
import { BenchmarkTask, BenchmarkCategory } from './evaluationService';
import {
  MeasurementEnvironment,
  HardwareFingerprint,
  StatisticalSummary
} from './measurementEnvironment';

/**
 * Deliverable 12.1: Model-Parametric Benchmark Harness
 * Extends the 30-task corpus with model, context, and quantization parameterization,
 * throughput tracking, failure taxonomy, versioned JSON schema, and Markdown report synthesis.
 */

export type FailureTaxonomyType =
  | 'syntax_error'
  | 'test_failure'
  | 'hallucinated_import'
  | 'context_overflow'
  | 'timeout'
  | 'crash';

export interface ParametricBenchmarkConfig {
  model: string;
  numCtx?: number; // default 8192
  temperature?: number; // default 0.0 for deterministic measurement
  seed?: number; // default 42
  runs?: number; // default 3 (N >= 3)
  categoryFilter?: BenchmarkCategory;
  taskIds?: string[];
  timeoutMs?: number; // default 45000 per task
}

export interface ParametricTaskRun {
  runIndex: number;
  isWarm: boolean;
  isCold: boolean;
  passed: boolean;
  durationMs: number;
  timeToFirstTokenMs: number;
  promptTokens: number;
  completionTokens: number;
  promptEvalTokensPerSec: number;
  generationTokensPerSec: number;
  failureType?: FailureTaxonomyType;
  error?: string;
  output?: string;
}

export interface ParametricTaskResult {
  taskId: string;
  taskName: string;
  category: BenchmarkCategory;
  runs: ParametricTaskRun[];
  passedRate: number; // 0.0 to 1.0
  warmGenerationThroughput: StatisticalSummary;
  promptEvalThroughput: StatisticalSummary;
  coldTtftMs: number;
  warmTtftMs: StatisticalSummary;
  dominantFailureType?: FailureTaxonomyType;
}

export interface ParametricBenchmarkResult {
  schemaVersion: '1.0.0';
  runId: string;
  timestamp: string;
  hardwareFingerprint: HardwareFingerprint;
  config: Required<Omit<ParametricBenchmarkConfig, 'categoryFilter' | 'taskIds'>> & {
    categoryFilter?: BenchmarkCategory;
    taskIds?: string[];
  };
  totalTasks: number;
  passedTasks: number;
  overallPassRate: number; // 0.0 to 1.0
  categoryBreakdown: Record<BenchmarkCategory, { total: number; passed: number; passRate: number }>;
  throughputStats: {
    generationTokensPerSec: StatisticalSummary;
    promptEvalTokensPerSec: StatisticalSummary;
    timeToFirstTokenMs: StatisticalSummary;
    coldTtftMs: number;
  };
  failureTaxonomy: Record<FailureTaxonomyType, number>;
  tasks: ParametricTaskResult[];
}

export class ParametricBenchmarkHarness {
  private _ollamaService: OllamaService;

  constructor(
    ollamaService: OllamaService
  ) {
    this._ollamaService = ollamaService;
  }

  /**
   * Classifies an execution failure into the standardized failure taxonomy.
   */
  public static classifyFailure(
    error?: string,
    output?: string,
    task?: BenchmarkTask
  ): FailureTaxonomyType {
    const errText = (error || '').toLowerCase();
    const outText = (output || '').toLowerCase();

    // 1. Timeout
    if (errText.includes('timeout') || errText.includes('timed out') || errText.includes('time limit')) {
      return 'timeout';
    }

    // 2. Crash or connection drop
    if (
      errText.includes('econnrefused') ||
      errText.includes('500') ||
      errText.includes('crash') ||
      errText.includes('vram') ||
      errText.includes('abort') ||
      errText.includes('socket hang up')
    ) {
      return 'crash';
    }

    // 3. Context overflow / truncation
    if (
      errText.includes('context') ||
      errText.includes('num_ctx') ||
      outText.includes('truncated') ||
      (output && output.endsWith('...') && output.length > 2000) ||
      (outText.includes('```') && !output?.trim().endsWith('```') && output && output.length > 3000)
    ) {
      return 'context_overflow';
    }

    // 4. Hallucinated import / missing module
    if (
      errText.includes('cannot find module') ||
      errText.includes('module not found') ||
      outText.includes('cannot find module') ||
      /import\s+.*from\s+['"][^'"]*unknown[^'"]*['"]/i.test(output || '')
    ) {
      return 'hallucinated_import';
    }

    // 5. Syntax error
    if (
      errText.includes('syntaxerror') ||
      errText.includes('unexpected token') ||
      errText.includes('unexpected end') ||
      outText.includes('syntaxerror')
    ) {
      return 'syntax_error';
    }

    // 6. Default to standard test / assertion failure
    return 'test_failure';
  }

  /**
   * Evaluates task output against expected output specifications.
   */
  public static verifyTaskOutput(
    task: BenchmarkTask,
    output: string
  ): { passed: boolean; error?: string } {
    if (!output || output.trim().length === 0) {
      return { passed: false, error: 'Empty output received from model' };
    }

    if (task.expectedOutputs) {
      // Must contain checks
      if (task.expectedOutputs.mustContain && task.expectedOutputs.mustContain.length > 0) {
        const anyMatch = task.expectedOutputs.mustContain.some(token => output.includes(token));
        if (!anyMatch) {
          return {
            passed: false,
            error: `Output missing required tokens. Expected one of: ${task.expectedOutputs.mustContain.map(t => JSON.stringify(t)).join(', ')}`
          };
        }
      }

      // Must not contain checks
      if (task.expectedOutputs.mustNotContain) {
        for (const token of task.expectedOutputs.mustNotContain) {
          if (output.includes(token)) {
            return {
              passed: false,
              error: `Output contains prohibited token: ${JSON.stringify(token)}`
            };
          }
        }
      }
    }

    return { passed: true };
  }

  /**
   * Executes a full model-parametric benchmark run against the 30-task corpus.
   */
  public async runBenchmark(
    config: ParametricBenchmarkConfig,
    options?: {
      onProgress?: (completedTasks: number, totalTasks: number, currentTask: string) => void;
      cancelSignal?: { aborted: boolean };
      customCorpus?: BenchmarkTask[];
    }
  ): Promise<ParametricBenchmarkResult> {
    const model = config.model;
    const numCtx = config.numCtx ?? 8192;
    const temperature = config.temperature ?? 0.0;
    const seed = config.seed ?? MeasurementEnvironment.getFixedSeed();
    const runsCount = Math.max(1, config.runs ?? 3);
    const timeoutMs = config.timeoutMs ?? 45000;

    // Filter corpus
    let corpus = options?.customCorpus ?? BENCHMARK_CORPUS_30;
    if (config.categoryFilter) {
      corpus = corpus.filter(t => t.category === config.categoryFilter);
    }
    if (config.taskIds && config.taskIds.length > 0) {
      const allowed = new Set(config.taskIds);
      corpus = corpus.filter(t => allowed.has(t.id));
    }

    // Capture hardware fingerprint at start of run
    const fingerprint = await MeasurementEnvironment.captureHardwareFingerprint();

    const failureCounts: Record<FailureTaxonomyType, number> = {
      syntax_error: 0,
      test_failure: 0,
      hallucinated_import: 0,
      context_overflow: 0,
      timeout: 0,
      crash: 0
    };

    const taskResults: ParametricTaskResult[] = [];
    const allWarmThroughputs: number[] = [];
    const allPromptEvalThroughputs: number[] = [];
    const allWarmTtfMs: number[] = [];
    let firstColdTtftMs = 0;

    const totalTasks = corpus.length;
    let completedTasks = 0;

    for (const task of corpus) {
      if (options?.cancelSignal?.aborted) {
        break;
      }

      if (options?.onProgress) {
        options.onProgress(completedTasks, totalTasks, task.name);
      }

      const taskRuns: ParametricTaskRun[] = [];

      for (let r = 0; r < runsCount; r++) {
        if (options?.cancelSignal?.aborted) {
          break;
        }

        const { isWarm, isCold } = MeasurementEnvironment.classifyRunWarmth(r);
        let firstTokenTime: number | null = null;
        let completionTokens = 0;
        let lastMetadata: OllamaChatMetadata | undefined;

        const startTime = Date.now();
        let output = '';
        let runError: string | undefined;

        try {
          const timeoutPromise = new Promise<string>((_, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`Task execution timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
          });

          const executionPromise = this._ollamaService.streamChat(
            model,
            [
              {
                role: 'system',
                content: 'You are an expert programming assistant. Provide precise, clean code solutions.'
              },
              { role: 'user', content: task.prompt }
            ],
            (chunk: string) => {
              if (firstTokenTime === null) {
                firstTokenTime = Date.now() - startTime;
              }
              completionTokens += Math.max(1, Math.round(chunk.length / 4));
            },
            undefined, // AbortSignal
            {
              num_ctx: numCtx,
              temperature,
              seed
            },
            {
              headersTimeoutMs: timeoutMs,
              idleStreamTimeoutMs: timeoutMs,
              totalTimeoutMs: timeoutMs
            },
            (meta: OllamaChatMetadata) => {
              lastMetadata = meta;
            }
          );

          output = await Promise.race([executionPromise, timeoutPromise]);
        } catch (err: any) {
          runError = err.message || String(err);
        }

        const durationMs = Date.now() - startTime;
        const ttftMs = firstTokenTime ?? durationMs;

        if (isCold && firstColdTtftMs === 0) {
          firstColdTtftMs = ttftMs;
        }

        // Output verification
        let passed = false;
        let failureType: FailureTaxonomyType | undefined;

        if (runError) {
          passed = false;
          failureType = ParametricBenchmarkHarness.classifyFailure(runError, output, task);
        } else {
          const verification = ParametricBenchmarkHarness.verifyTaskOutput(task, output);
          passed = verification.passed;
          if (!passed) {
            runError = verification.error;
            failureType = ParametricBenchmarkHarness.classifyFailure(runError, output, task);
          }
        }

        if (failureType) {
          failureCounts[failureType]++;
        }

        // Calculate throughput metrics
        let promptTokens = Math.max(1, Math.round(task.prompt.length / 4));
        let promptEvalTokensPerSec = 0;
        let generationTokensPerSec = 0;

        if (lastMetadata) {
          if (lastMetadata.prompt_eval_count && lastMetadata.prompt_eval_duration) {
            promptTokens = lastMetadata.prompt_eval_count;
            promptEvalTokensPerSec = (lastMetadata.prompt_eval_count / (lastMetadata.prompt_eval_duration / 1e9));
          }
          if (lastMetadata.eval_count && lastMetadata.eval_duration) {
            completionTokens = lastMetadata.eval_count;
            generationTokensPerSec = (lastMetadata.eval_count / (lastMetadata.eval_duration / 1e9));
          }
        }

        // Fallback throughput estimation if metadata not reported by engine
        if (generationTokensPerSec === 0 && durationMs > ttftMs && completionTokens > 0) {
          const genDurationSec = (durationMs - ttftMs) / 1000;
          if (genDurationSec > 0) {
            generationTokensPerSec = completionTokens / genDurationSec;
          }
        }

        if (isWarm && generationTokensPerSec > 0) {
          allWarmThroughputs.push(generationTokensPerSec);
        }
        if (isWarm) {
          allWarmTtfMs.push(ttftMs);
        }
        if (promptEvalTokensPerSec > 0) {
          allPromptEvalThroughputs.push(promptEvalTokensPerSec);
        }

        taskRuns.push({
          runIndex: r,
          isWarm,
          isCold,
          passed,
          durationMs,
          timeToFirstTokenMs: ttftMs,
          promptTokens,
          completionTokens,
          promptEvalTokensPerSec: Math.round(promptEvalTokensPerSec * 10) / 10,
          generationTokensPerSec: Math.round(generationTokensPerSec * 10) / 10,
          failureType,
          error: runError,
          output
        });
      }

      // Aggregate task summary
      const passedCount = taskRuns.filter(r => r.passed).length;
      const passRate = taskRuns.length > 0 ? passedCount / taskRuns.length : 0;
      const warmRuns = taskRuns.filter(r => r.isWarm);
      const warmGenerations = warmRuns.map(r => r.generationTokensPerSec).filter(t => t > 0);
      const warmTfts = warmRuns.map(r => r.timeToFirstTokenMs);
      const promptEvals = taskRuns.map(r => r.promptEvalTokensPerSec).filter(t => t > 0);
      const coldRun = taskRuns.find(r => !r.isWarm);

      const dominantFailure = taskRuns.find(r => r.failureType)?.failureType;

      taskResults.push({
        taskId: task.id,
        taskName: task.name,
        category: task.category,
        runs: taskRuns,
        passedRate: Math.round(passRate * 100) / 100,
        warmGenerationThroughput: MeasurementEnvironment.calculateStatistics(warmGenerations),
        promptEvalThroughput: MeasurementEnvironment.calculateStatistics(promptEvals),
        coldTtftMs: coldRun?.timeToFirstTokenMs ?? 0,
        warmTtftMs: MeasurementEnvironment.calculateStatistics(warmTfts),
        dominantFailureType: dominantFailure
      });

      completedTasks++;
    }

    // Category breakdown
    const categoryBreakdown: Record<BenchmarkCategory, { total: number; passed: number; passRate: number }> = {
      code_repair: { total: 0, passed: 0, passRate: 0 },
      feature_gen: { total: 0, passed: 0, passRate: 0 },
      refactor: { total: 0, passed: 0, passRate: 0 },
      tool_use: { total: 0, passed: 0, passRate: 0 }
    };

    for (const t of taskResults) {
      if (!categoryBreakdown[t.category]) {
        categoryBreakdown[t.category] = { total: 0, passed: 0, passRate: 0 };
      }
      categoryBreakdown[t.category].total++;
      if (t.passedRate >= 0.5) {
        categoryBreakdown[t.category].passed++;
      }
    }

    for (const cat of Object.keys(categoryBreakdown) as BenchmarkCategory[]) {
      const entry = categoryBreakdown[cat];
      entry.passRate = entry.total > 0 ? Math.round((entry.passed / entry.total) * 100) / 100 : 0;
    }

    const passedTasks = taskResults.filter(t => t.passedRate >= 0.5).length;
    const overallPassRate = totalTasks > 0 ? Math.round((passedTasks / totalTasks) * 100) / 100 : 0;

    const runId = `bench_${Date.now()}_${model.replace(/[^a-zA-Z0-9_-]/g, '_')}_ctx${numCtx}`;

    return {
      schemaVersion: '1.0.0',
      runId,
      timestamp: new Date().toISOString(),
      hardwareFingerprint: fingerprint,
      config: {
        model,
        numCtx,
        temperature,
        seed,
        runs: runsCount,
        timeoutMs,
        categoryFilter: config.categoryFilter,
        taskIds: config.taskIds
      },
      totalTasks,
      passedTasks,
      overallPassRate,
      categoryBreakdown,
      throughputStats: {
        generationTokensPerSec: MeasurementEnvironment.calculateStatistics(allWarmThroughputs),
        promptEvalTokensPerSec: MeasurementEnvironment.calculateStatistics(allPromptEvalThroughputs),
        timeToFirstTokenMs: MeasurementEnvironment.calculateStatistics(allWarmTtfMs),
        coldTtftMs: firstColdTtftMs
      },
      failureTaxonomy: failureCounts,
      tasks: taskResults
    };
  }

  /**
   * Persists a benchmark result atomically to disk as versioned JSON.
   */
  public async saveResult(
    result: ParametricBenchmarkResult,
    targetDirectory?: string
  ): Promise<string> {
    const targetFolder = WorkspaceManager.getTargetWorkspaceFolder();
    const wsRoot = targetFolder ? targetFolder.uri.fsPath : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    const baseDir = targetDirectory || path.join(wsRoot, '.vscode', 'local-copilot', 'benchmarks');
    const fileName = `${result.runId}.json`;
    const fullPath = path.join(baseDir, fileName);

    await AtomicFileWriter.writeJson(vscode.Uri.file(fullPath), result);
    return fullPath;
  }

  /**
   * Synthesizes a structured, GitHub Flavored Markdown evaluation report from the benchmark result.
   */
  public static generateMarkdownReport(result: ParametricBenchmarkResult): string {
    const fp = result.hardwareFingerprint;
    const cfg = result.config;
    const st = result.throughputStats;
    const cats = result.categoryBreakdown;
    const fail = result.failureTaxonomy;

    const vramGB = fp.totalVramBytes > 0 ? (fp.totalVramBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : 'N/A';
    const ramGB = (fp.totalRamBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';

    let md = `# Benchmark Run Report: \`${cfg.model}\` (ctx: ${cfg.numCtx})

**Run ID**: \`${result.runId}\`  
**Timestamp**: ${result.timestamp}  
**Schema Version**: \`${result.schemaVersion}\`  

---

## 1. Hardware & Environment Fingerprint

| Component | Specifications |
|-----------|----------------|
| **GPU** | ${fp.gpuName} (Driver: ${fp.driverVersion}, Total VRAM: ${vramGB}) |
| **CPU** | ${fp.cpuModel} (${fp.logicalCores} logical cores, ${fp.cpuArch}) |
| **System RAM** | ${ramGB} |
| **OS** | ${fp.osPlatform} (${fp.osRelease}) |
| **Ollama Runtime** | \`${fp.ollamaVersion}\` |
| **Node.js / VS Code** | Node ${fp.nodeVersion} / VS Code ${fp.vscodeVersion} |

---

## 2. Benchmark Parameters

- **Model Tag**: \`${cfg.model}\`
- **Context Window (\`numCtx\`)**: ${cfg.numCtx} tokens
- **Temperature**: ${cfg.temperature} (deterministic)
- **Random Seed**: ${cfg.seed}
- **Repetitions ($N$)**: ${cfg.runs} runs per task (Run 0 cold, Runs 1..${cfg.runs - 1} warm)

---

## 3. Executive Performance Summary

| Metric | Measured Value |
|--------|----------------|
| **Overall Pass Rate** | **${(result.overallPassRate * 100).toFixed(1)}%** (${result.passedTasks}/${result.totalTasks} tasks) |
| **Generation Throughput (Warm)** | **${st.generationTokensPerSec.mean} t/s** (std: ${st.generationTokensPerSec.stdDev}, p50: ${st.generationTokensPerSec.p50}, p95: ${st.generationTokensPerSec.p95}) |
| **Prompt Eval Throughput** | **${st.promptEvalTokensPerSec.mean} t/s** (std: ${st.promptEvalTokensPerSec.stdDev}) |
| **Cold TTFT (Run 0)** | **${st.coldTtftMs} ms** |
| **Warm TTFT (Runs 1+)** | **${st.timeToFirstTokenMs.mean} ms** (p50: ${st.timeToFirstTokenMs.p50} ms) |

---

## 4. Category Score Matrix

| Category | Tasks | Passed | Pass Rate |
|----------|-------|--------|-----------|
| **Code Repair** | ${cats.code_repair.total} | ${cats.code_repair.passed} | ${(cats.code_repair.passRate * 100).toFixed(0)}% |
| **Feature Generation** | ${cats.feature_gen.total} | ${cats.feature_gen.passed} | ${(cats.feature_gen.passRate * 100).toFixed(0)}% |
| **Refactoring** | ${cats.refactor.total} | ${cats.refactor.passed} | ${(cats.refactor.passRate * 100).toFixed(0)}% |
| **Tool Use** | ${cats.tool_use.total} | ${cats.tool_use.passed} | ${(cats.tool_use.passRate * 100).toFixed(0)}% |

---

## 5. Failure Taxonomy Breakdown

| Failure Type | Occurrences | Description |
|--------------|-------------|-------------|
| **\`test_failure\`** | ${fail.test_failure} | Output did not satisfy task assertion or token contract |
| **\`syntax_error\`** | ${fail.syntax_error} | Output contained invalid code syntax or unparseable blocks |
| **\`hallucinated_import\`** | ${fail.hallucinated_import} | Referenced nonexistent modules or unexported symbols |
| **\`context_overflow\`** | ${fail.context_overflow} | Output truncated or exceeded context capacity |
| **\`timeout\`** | ${fail.timeout} | Generation or test execution exceeded threshold |
| **\`crash\`** | ${fail.crash} | Process crash, VRAM exhaustion, or connection refusal |

---

## 6. Detailed Task-by-Task Results

| Task ID | Category | Pass Rate | Warm Throughput | Cold TTFT | Warm TTFT | Dominant Failure |
|---------|----------|-----------|-----------------|-----------|-----------|------------------|
`;

    for (const t of result.tasks) {
      const passBadge = t.passedRate >= 1.0 ? '✅ 100%' : (t.passedRate > 0 ? `⚠️ ${(t.passedRate * 100).toFixed(0)}%` : '❌ 0%');
      const genRate = t.warmGenerationThroughput.mean > 0 ? `${t.warmGenerationThroughput.mean} t/s` : 'N/A';
      const failTag = t.dominantFailureType ? `\`${t.dominantFailureType}\`` : '-';
      md += `| \`${t.taskId}\` | ${t.category} | ${passBadge} | ${genRate} | ${t.coldTtftMs} ms | ${t.warmTtftMs.mean} ms | ${failTag} |\n`;
    }

    return md;
  }
}
