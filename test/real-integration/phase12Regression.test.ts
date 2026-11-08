import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ModelRouter, ModelProfile } from '../../src/services/modelRouter';
import { BenchmarkReportGenerator } from '../../src/services/benchmarkReportGenerator';
import { ParametricBenchmarkResult } from '../../src/services/parametricBenchmarkHarness';
import { resetMockState, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Phase 12: Real Filesystem & Model Intelligence Regression Tier', function () {
  this.timeout(15000);

  let tempDir: string;
  let originalFs: any;
  let rootUri: vscode.Uri;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase12-real-'));
    rootUri = vscode.Uri.file(tempDir);
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { uri: rootUri, name: 'phase12-test-ws', index: 0 }
    ]);
    originalFs = vscode.workspace.fs;

    // Real OS filesystem bridge
    (vscode.workspace as any).fs = {
      async createDirectory(uri: vscode.Uri) {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
      },
      async writeFile(uri: vscode.Uri, content: Uint8Array) {
        const dir = path.dirname(uri.fsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        await fs.promises.writeFile(uri.fsPath, Buffer.from(content));
      },
      async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const buf = await fs.promises.readFile(uri.fsPath);
        return new Uint8Array(buf);
      },
      async rename(src: vscode.Uri, dest: vscode.Uri) {
        const destDir = path.dirname(dest.fsPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        await fs.promises.rename(src.fsPath, dest.fsPath);
      },
      async delete(uri: vscode.Uri) {
        if (fs.existsSync(uri.fsPath)) {
          await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
        }
      },
      async stat(uri: vscode.Uri) {
        const st = await fs.promises.stat(uri.fsPath);
        return {
          type: st.isDirectory() ? 2 : 1,
          ctime: st.ctimeMs,
          mtime: st.mtimeMs,
          size: st.size
        };
      }
    };
  });

  afterEach(() => {
    (vscode.workspace as any).fs = originalFs;
    resetMockState();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should save, list, and reload ModelProfile on real filesystem', async () => {
    const profile: ModelProfile = {
      modelTag: 'real-test-model:7b',
      measuredTps: 36.8,
      vramBytes: 4.8 * 1024 * 1024 * 1024,
      effectiveContextTokens: 8192,
      toolCallReliability: 0.94,
      categoryStrengths: {
        code_repair: 92,
        feature_gen: 85,
        refactor: 88,
        reasoning: 74
      },
      swapCostMs: 4200
    };

    const savedPath = await ModelRouter.saveProfile(profile, tempDir);
    assert.ok(fs.existsSync(savedPath));

    const reloaded = await ModelRouter.loadProfile('real-test-model:7b', tempDir);
    assert.ok(reloaded !== null);
    assert.strictEqual(reloaded!.modelTag, 'real-test-model:7b');
    assert.strictEqual(reloaded!.measuredTps, 36.8);
    assert.strictEqual(reloaded!.categoryStrengths.code_repair, 92);
  });

  it('should generate and write BenchmarkReport to real filesystem atomically', async () => {
    const mockResult: ParametricBenchmarkResult = {
      schemaVersion: '1.0.0',
      runId: 'real_bench_01',
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
      passedTasks: 30,
      overallPassRate: 1.0,
      categoryBreakdown: {
        code_repair: { total: 10, passed: 10, passRate: 1.0 },
        feature_gen: { total: 8, passed: 8, passRate: 1.0 },
        refactor: { total: 7, passed: 7, passRate: 1.0 },
        tool_use: { total: 5, passed: 5, passRate: 1.0 }
      },
      throughputStats: {
        generationTokensPerSec: { runs: 3, mean: 35.0, stdDev: 0.8, min: 34.2, max: 35.8, p50: 35.0, p95: 35.7 },
        promptEvalTokensPerSec: { runs: 3, mean: 215.0, stdDev: 5.0, min: 210.0, max: 220.0, p50: 215.0, p95: 219.5 },
        timeToFirstTokenMs: { runs: 3, mean: 440, stdDev: 20, min: 420, max: 460, p50: 440, p95: 458 },
        coldTtftMs: 3600
      },
      failureTaxonomy: {
        syntax_error: 0,
        test_failure: 0,
        hallucinated_import: 0,
        context_overflow: 0,
        timeout: 0,
        crash: 0
      },
      tasks: []
    };

    const reportMd = BenchmarkReportGenerator.generateMultiModelReport([mockResult]);
    const reportPath = path.join(tempDir, 'PHASE_12_BENCHMARK_REPORT.md');

    await BenchmarkReportGenerator.writeReportToFile(reportPath, reportMd);

    assert.ok(fs.existsSync(reportPath));
    const content = fs.readFileSync(reportPath, 'utf8');
    assert.ok(content.includes('PHASE 12 MODEL INTELLIGENCE BENCHMARK RESULTS'));
    assert.ok(content.includes('100% (30/30)'));
  });
});
