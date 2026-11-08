import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CalibrationWizard } from '../../src/services/calibrationWizard';
import { resetMockState, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Deliverable 12.6: Model Calibration Wizard (/tune) Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-test-'));
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { uri: vscode.Uri.file(tempDir), name: 'tune-ws', index: 0 }
    ]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should calibrate model and persist ModelProfile atomically using mock Ollama', async () => {
    const mockOllama: any = {
      ping: async () => true,
      streamChat: async (
        _model: string,
        _messages: any[],
        onChunk: (chunk: string) => void
      ) => {
        onChunk('READY function fibonacci(n: number) { return n <= 1 ? n : fib(n-1) + fib(n-2); } readFile package.json');
        return 'READY';
      }
    };

    const progressSteps: string[] = [];
    const result = await CalibrationWizard.calibrateModel('mock-coder:7b', {
      ollamaService: mockOllama,
      onProgress: p => progressSteps.push(p.step),
      baseDir: tempDir
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.modelTag, 'mock-coder:7b');
    assert.ok(result.profile !== undefined);
    assert.ok(result.profile!.measuredTps > 0);
    assert.ok(result.profile!.swapCostMs > 0);
    assert.strictEqual(result.profile!.toolCallReliability, 0.95);
    assert.ok(progressSteps.includes('preflight'));
    assert.ok(progressSteps.includes('cold_load'));
    assert.ok(progressSteps.includes('throughput'));
    assert.ok(progressSteps.includes('tool_calling'));
    assert.ok(progressSteps.includes('complete'));

    // Verify profile file was generated and saved
    assert.ok(result.profilePath !== undefined);
    assert.ok(result.profilePath!.includes('mock-coder_7b.json'));
  });

  it('should fail gracefully when Ollama daemon is unreachable', async () => {
    const mockOllama: any = {
      ping: async () => false
    };

    const result = await CalibrationWizard.calibrateModel('unreachable:7b', {
      ollamaService: mockOllama,
      baseDir: tempDir
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.errorMessage?.includes('not reachable'));
  });
});
