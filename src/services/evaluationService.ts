import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaService } from './ollamaService';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';
import { BENCHMARK_CORPUS_30, BenchmarkComparison, compareBenchmarkRuns } from './benchmarkTaskCorpus';

export type BenchmarkCategory = 'code_repair' | 'feature_gen' | 'refactor' | 'tool_use';

export interface BenchmarkTask {
    id: string;
    name: string;
    category: BenchmarkCategory;
    prompt: string;
    initialFiles?: Record<string, string>;
    expectedOutputs?: {
        fileMatches?: Record<string, string | RegExp>;
        mustContain?: string[];
        mustNotContain?: string[];
    };
    timeoutMs?: number;
}

export interface TaskEvaluationResult {
    taskId: string;
    taskName: string;
    category: BenchmarkCategory;
    passed: boolean;
    durationMs: number;
    tokensGenerated?: number;
    error?: string;
    details?: Record<string, any>;
}

export interface BenchmarkSuiteResult {
    runId: string;
    timestamp: string;
    model: string;
    totalTasks: number;
    passedTasks: number;
    taskCompletionRate: number; // 0.0 - 1.0
    categoryScores: Record<BenchmarkCategory, { total: number; passed: number; passRate: number }>;
    totalDurationMs: number;
    results: TaskEvaluationResult[];
}

export interface RunSuiteOptions {
    repetitions?: number;
    isolateWorkspace?: boolean;
}

export class EvaluationService {
    private _ollamaService: OllamaService;

    constructor(
        ollamaService: OllamaService
    ) {
        this._ollamaService = ollamaService;
    }

    /**
     * Standard built-in evaluation tasks designed for local 7B-9B model assessment.
     */
    public getBuiltinTasks(): BenchmarkTask[] {
        return [
            {
                id: 'repair-null-deref',
                name: 'Null Reference Repair',
                category: 'code_repair',
                prompt: 'Fix the null pointer bug in getUserName so it safely returns "Guest" when user or name is null or undefined:\nfunction getUserName(user) { return user.name; }',
                expectedOutputs: {
                    mustContain: ['return user?.name ?? "Guest"', 'user && user.name', 'if (!user', 'user?.name || "Guest"']
                }
            },
            {
                id: 'feature-filter-active',
                name: 'Active Items Filter Feature',
                category: 'feature_gen',
                prompt: 'Write a TypeScript function filterActiveUsers(users: Array<{ id: string; active: boolean }>) that returns only active users.',
                expectedOutputs: {
                    mustContain: ['filterActiveUsers', 'users.filter', 'user.active']
                }
            },
            {
                id: 'refactor-var-to-const',
                name: 'Modernize var declarations',
                category: 'refactor',
                prompt: 'Refactor the following code to use const and let instead of var, and arrow functions:\nvar count = 0;\nvar add = function(a, b) { return a + b; };',
                expectedOutputs: {
                    mustContain: ['const add = (', 'let count = 0', 'const count = 0'],
                    mustNotContain: ['var count', 'var add']
                }
            },
            {
                id: 'tool-use-json-payload',
                name: 'Tool Invocation Syntax',
                category: 'tool_use',
                prompt: 'Generate an agent tool call JSON to read the file "src/index.ts". Output format: {"tool": "readFile", "args": {"path": "src/index.ts"}}',
                expectedOutputs: {
                    mustContain: ['"tool": "readFile"', '"path": "src/index.ts"']
                }
            }
        ];
    }

    /**
     * Specialized multi-file workspace discovery and explore-before-ask benchmark task.
     */
    public getMultiFileDiscoveryBenchmarkTasks(): BenchmarkTask[] {
        return [
            {
                id: 'multi-file-workspace-discovery-explore',
                name: 'Multi-File Workspace Discovery & Explore-Before-Ask',
                category: 'tool_use',
                prompt: 'Given a workspace with Backend.Api (.csproj) and Frontend.Client (package.json with @angular/core), inspect the project structure and list the missing files instead of asking for clarification on which backend framework is used.',
                expectedOutputs: {
                    mustContain: ['Backend.Api', 'Frontend.Client'],
                    mustNotContain: ['what backend framework', 'which backend']
                }
            }
        ];
    }

    /**
     * Comprehensive 30-task benchmark corpus for local 7B-9B LLMs.
     */
    public getCorpus30Tasks(): BenchmarkTask[] {
        return [...BENCHMARK_CORPUS_30];
    }

    /**
     * Compares two benchmark suite results to evaluate capability improvements or regressions.
     */
    public compareRuns(baseline: BenchmarkSuiteResult, candidate: BenchmarkSuiteResult): BenchmarkComparison {
        return compareBenchmarkRuns(baseline, candidate);
    }

    /**
     * Executes a benchmark suite against the specified model.
     */
    public async runSuite(
        model: string,
        tasks?: BenchmarkTask[],
        targetRootUri?: vscode.Uri,
        cancellationToken?: vscode.CancellationToken,
        options?: RunSuiteOptions
    ): Promise<BenchmarkSuiteResult> {
        const runTasks = tasks && tasks.length > 0 ? tasks : this.getBuiltinTasks();
        const startTime = Date.now();
        const results: TaskEvaluationResult[] = [];
        const repetitions = options?.repetitions && options.repetitions > 1 ? options.repetitions : 1;

        for (const task of runTasks) {
            if (cancellationToken?.isCancellationRequested) {
                break;
            }

            let taskPassed = true;
            let totalTaskDuration = 0;
            let lastError: string | undefined;
            let lastDetails: Record<string, any> | undefined;

            for (let rep = 0; rep < repetitions; rep++) {
                if (cancellationToken?.isCancellationRequested) break;
                const repStart = Date.now();
                try {
                    const response = await this._executeTaskPrompt(model, task.prompt);
                    const evaluation = this._evaluateResponse(task, response);
                    totalTaskDuration += (Date.now() - repStart);
                    if (!evaluation.passed) {
                        taskPassed = false;
                        lastError = evaluation.error;
                    }
                    lastDetails = evaluation.details;
                } catch (err: any) {
                    totalTaskDuration += (Date.now() - repStart);
                    taskPassed = false;
                    lastError = err?.message || String(err);
                }
            }

            results.push({
                taskId: task.id,
                taskName: task.name,
                category: task.category,
                passed: taskPassed,
                durationMs: Math.round(totalTaskDuration / repetitions),
                error: lastError,
                details: {
                    ...lastDetails,
                    repetitionsRun: repetitions
                }
            });
        }

        const totalTasks = results.length;
        const passedTasks = results.filter(r => r.passed).length;
        const taskCompletionRate = totalTasks > 0 ? passedTasks / totalTasks : 0;

        const categoryScores: Record<BenchmarkCategory, { total: number; passed: number; passRate: number }> = {
            code_repair: { total: 0, passed: 0, passRate: 0 },
            feature_gen: { total: 0, passed: 0, passRate: 0 },
            refactor: { total: 0, passed: 0, passRate: 0 },
            tool_use: { total: 0, passed: 0, passRate: 0 }
        };

        for (const r of results) {
            if (!categoryScores[r.category]) {
                categoryScores[r.category] = { total: 0, passed: 0, passRate: 0 };
            }
            categoryScores[r.category].total++;
            if (r.passed) {
                categoryScores[r.category].passed++;
            }
        }

        for (const cat of Object.keys(categoryScores) as BenchmarkCategory[]) {
            const entry = categoryScores[cat];
            entry.passRate = entry.total > 0 ? entry.passed / entry.total : 0;
        }

        const suiteResult: BenchmarkSuiteResult = {
            runId: `bench-${Date.now()}`,
            timestamp: new Date().toISOString(),
            model,
            totalTasks,
            passedTasks,
            taskCompletionRate,
            categoryScores,
            totalDurationMs: Date.now() - startTime,
            results
        };

        // Persist benchmark results if workspace root is available
        await this._persistResults(suiteResult, targetRootUri);

        return suiteResult;
    }

    private async _executeTaskPrompt(model: string, prompt: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let fullText = '';
            this._ollamaService.streamChat(
                model,
                [
                    { role: 'system', content: 'You are a rigorous coding assistant. Respond directly with clean code or the requested format without fluff.' },
                    { role: 'user', content: prompt }
                ],
                (chunk) => {
                    fullText += chunk;
                }
            ).then(() => resolve(fullText)).catch(reject);
        });
    }

    private _evaluateResponse(task: BenchmarkTask, response: string): { passed: boolean; error?: string; details?: any } {
        if (!task.expectedOutputs) {
            return { passed: true };
        }

        const { mustContain, mustNotContain } = task.expectedOutputs;

        if (mustContain && mustContain.length > 0) {
            // At least one of the alternatives or all patterns
            const hasMatch = mustContain.some(pattern => response.includes(pattern));
            if (!hasMatch) {
                return {
                    passed: false,
                    error: `Response did not contain any expected patterns: ${JSON.stringify(mustContain)}`,
                    details: { responseSnippet: response.slice(0, 300) }
                };
            }
        }

        if (mustNotContain && mustNotContain.length > 0) {
            for (const forbidden of mustNotContain) {
                if (response.includes(forbidden)) {
                    return {
                        passed: false,
                        error: `Response contained forbidden pattern: "${forbidden}"`,
                        details: { responseSnippet: response.slice(0, 300) }
                    };
                }
            }
        }

        return { passed: true };
    }

    private async _persistResults(suiteResult: BenchmarkSuiteResult, targetRootUri?: vscode.Uri): Promise<void> {
        try {
            const folder = WorkspaceManager.getTargetWorkspaceFolder(targetRootUri);
            if (!folder) {
                return;
            }
            const benchmarksDirUri = WorkspaceManager.getStorageUri(folder, 'benchmarks');
            const resultFileUri = vscode.Uri.joinPath(benchmarksDirUri, 'benchmark-results.json');

            let history: BenchmarkSuiteResult[] = [];
            const existing = await AtomicFileWriter.readJson<BenchmarkSuiteResult[]>(resultFileUri, []);
            if (Array.isArray(existing)) {
                history = existing;
            }
            history.unshift(suiteResult);
            // Cap history to 20 runs
            if (history.length > 20) {
                history = history.slice(0, 20);
            }

            await AtomicFileWriter.writeJson(resultFileUri, history);
        } catch (e) {
            // Silently allow benchmark completion even if persistence fails
            console.error('[EvaluationService] Failed to persist benchmark results:', e);
        }
    }
}
