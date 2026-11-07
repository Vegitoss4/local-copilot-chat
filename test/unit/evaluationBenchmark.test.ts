import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EvaluationService, BenchmarkTask } from '../../src/services/evaluationService';
import { WorkspaceManager } from '../../src/services/workspaceManager';
import { AtomicFileWriter } from '../../src/services/atomicFileWriter';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, setMockWorkspaceFolders, MockUri, mockFs } from '../mocks/vscodeMock';

describe('Phase 6.1: Evaluation and Benchmarking Framework Suite', () => {
    let tempDir: string;
    let mockOllamaService: any;
    let evaluationService: EvaluationService;

    beforeEach(() => {
        tempDir = 'C:\\Projects\\test-workspace';
        resetMockState(tempDir);
        setMockWorkspaceFolders([
            { name: 'eval-test-workspace', uri: MockUri.file(tempDir), index: 0 }
        ]);

        mockOllamaService = {
            streamChat: async (
                model: string,
                messages: any[],
                onChunk: (chunk: string) => void,
                signal?: any,
                options?: any
            ) => {
                const prompt = messages[messages.length - 1].content;
                if (prompt.includes('getUserName')) {
                    onChunk('function getUserName(user) {\n    return user?.name ?? "Guest";\n}');
                } else if (prompt.includes('filterActiveUsers')) {
                    onChunk('export function filterActiveUsers(users: Array<{ id: string; active: boolean }>) {\n    return users.filter(u => u.active);\n}');
                } else if (prompt.includes('var count = 0')) {
                    onChunk('let count = 0;\nconst add = (a: number, b: number) => a + b;');
                } else if (prompt.includes('tool call JSON') || prompt.includes('readFile')) {
                    onChunk('```json\n{"tool": "readFile", "args": {"path": "src/index.ts"}}\n```');
                } else {
                    onChunk('generic test response');
                }
            }
        };

        evaluationService = new EvaluationService(
            mockOllamaService as unknown as OllamaService
        );
    });

    afterEach(() => {
        resetMockState();
    });

    it('should expose standardized builtin tasks spanning repair, feature, refactor, and tool use', () => {
        const tasks = evaluationService.getBuiltinTasks();
        assert.strictEqual(tasks.length, 4);
        const categories = tasks.map(t => t.category);
        assert.ok(categories.includes('code_repair'));
        assert.ok(categories.includes('feature_gen'));
        assert.ok(categories.includes('refactor'));
        assert.ok(categories.includes('tool_use'));
    });

    it('should execute benchmark suite and achieve 100% TCR on conforming responses', async () => {
        const result = await evaluationService.runSuite('qwen2.5-coder:7b');

        assert.strictEqual(result.model, 'qwen2.5-coder:7b');
        assert.strictEqual(result.totalTasks, 4);
        assert.strictEqual(result.passedTasks, 4);
        assert.strictEqual(result.taskCompletionRate, 1.0);
        assert.strictEqual(result.categoryScores.code_repair.passRate, 1.0);
        assert.strictEqual(result.categoryScores.feature_gen.passRate, 1.0);
        assert.strictEqual(result.categoryScores.refactor.passRate, 1.0);
        assert.strictEqual(result.categoryScores.tool_use.passRate, 1.0);
        assert.ok(result.totalDurationMs >= 0);
    });

    it('should accurately fail tasks when responses omit expected patterns or contain forbidden syntax', async () => {
        const failingTask: BenchmarkTask = {
            id: 'fail-syntax',
            name: 'Strict Syntax Check',
            category: 'refactor',
            prompt: 'Refactor var',
            expectedOutputs: {
                mustContain: ['const magicNumber = 42'],
                mustNotContain: ['var count']
            }
        };

        const result = await evaluationService.runSuite('qwen2.5-coder:7b', [failingTask]);
        assert.strictEqual(result.totalTasks, 1);
        assert.strictEqual(result.passedTasks, 0);
        assert.strictEqual(result.taskCompletionRate, 0.0);
        assert.ok(result.results[0].error?.includes('Response did not contain any expected patterns'));
    });

    it('should handle LLM stream exceptions gracefully without crashing suite', async () => {
        mockOllamaService.streamChat = async () => {
            throw new Error('Ollama connection dropped abruptly');
        };

        const result = await evaluationService.runSuite('qwen2.5-coder:7b');
        assert.strictEqual(result.totalTasks, 4);
        assert.strictEqual(result.passedTasks, 0);
        assert.strictEqual(result.taskCompletionRate, 0.0);
        assert.strictEqual(result.results[0].error, 'Ollama connection dropped abruptly');
    });

    it('should persist benchmark results atomically to .vscode/local-copilot/benchmarks/benchmark-results.json', async () => {
        await evaluationService.runSuite('qwen2.5-coder:7b');

        const benchmarkPath = path.join(tempDir, '.vscode', 'local-copilot', 'benchmarks', 'benchmark-results.json');
        const rawContent = mockFs.getFile(benchmarkPath);
        assert.ok(rawContent !== undefined, 'benchmark-results.json should exist in mockFs');

        const content = JSON.parse(rawContent!);
        assert.ok(Array.isArray(content));
        assert.strictEqual(content.length, 1);
        assert.strictEqual(content[0].model, 'qwen2.5-coder:7b');
        assert.strictEqual(content[0].passedTasks, 4);
    });

    it('should respect cancellation token during suite execution', async () => {
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel(); // Cancel immediately

        const result = await evaluationService.runSuite('qwen2.5-coder:7b', undefined, undefined, tokenSource.token);
        assert.strictEqual(result.totalTasks, 0);
    });

    it('should execute tasks with N repetitions and record repetition metrics', async () => {
        const singleTask: BenchmarkTask = {
            id: 'rep-test',
            name: 'Repetition Test',
            category: 'code_repair',
            prompt: 'Fix getUserName',
            expectedOutputs: {
                mustContain: ['getUserName']
            }
        };

        const result = await evaluationService.runSuite(
            'qwen2.5-coder:7b',
            [singleTask],
            undefined,
            undefined,
            { repetitions: 3 }
        );

        assert.strictEqual(result.totalTasks, 1);
        assert.strictEqual(result.passedTasks, 1);
        assert.strictEqual(result.results[0].details?.repetitionsRun, 3);
    });
});
