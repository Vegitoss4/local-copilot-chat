import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SessionPersistenceService, SessionDataV2 } from '../../src/services/sessionPersistenceService';
import { CheckpointManager } from '../../src/services/checkpointManager';
import { GitIntelligenceService } from '../../src/services/gitIntelligenceService';
import { ParametricBenchmarkHarness } from '../../src/services/parametricBenchmarkHarness';
import { OllamaService } from '../../src/services/ollamaService';
import { BenchmarkTask } from '../../src/services/evaluationService';
import { resetMockState, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Phase 11.9: Real Filesystem & SessionEngine Regression Tier', function () {
  this.timeout(15000);

  let tempDir: string;
  let originalFs: any;
  let rootUri: vscode.Uri;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase11-real-'));
    rootUri = vscode.Uri.file(tempDir);
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { uri: rootUri, name: 'real-test-ws', index: 0 }
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
      async rename(src: vscode.Uri, dest: vscode.Uri, options?: { overwrite?: boolean }) {
        const destDir = path.dirname(dest.fsPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        await fs.promises.rename(src.fsPath, dest.fsPath);
      },
      async delete(uri: vscode.Uri, _options?: { recursive?: boolean; useTrash?: boolean }) {
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

  it('should save, list, and reload Session Schema v2 on real filesystem', async () => {
    const service = SessionPersistenceService.getInstance();

    const session: SessionDataV2 = {
      schemaVersion: '2.0.0',
      sessionId: 'real_sess_01',
      title: 'Real Filesystem Session',
      mode: 'agent',
      model: 'qwen2.5-coder:7b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { role: 'user', content: 'Create index.ts' },
        { role: 'assistant', content: '<think>reasoning</think>Created index.ts cleanly.' }
      ]
    };

    await service.saveSession(session, rootUri);

    // Verify session file exists on real disk
    const sessionPath = path.join(tempDir, '.vscode', 'local-copilot', 'sessions', 'real_sess_01.json');
    assert.ok(fs.existsSync(sessionPath), 'Session file must exist on real disk');

    // Reload and verify contents
    const loaded = await service.loadSession('real_sess_01', rootUri);
    assert.ok(loaded);
    assert.strictEqual(loaded.sessionId, 'real_sess_01');
    assert.strictEqual(loaded.title, 'Real Filesystem Session');
    assert.strictEqual(loaded.messages.length, 2);
    // Verify thought tokens stripped on save
    assert.strictEqual(loaded.messages[1].content, 'Created index.ts cleanly.');

    // Verify index exists and includes session
    const list = await service.listSessions(rootUri);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].sessionId, 'real_sess_01');
  });

  it('should create content-addressed checkpoint and rewind on real filesystem', async () => {
    const manager = CheckpointManager.getInstance();

    // Create an initial file
    const targetFile = path.join(tempDir, 'main.ts');
    fs.writeFileSync(targetFile, 'console.log("initial version");', 'utf-8');

    // Create checkpoint
    const cpId = await manager.createCheckpoint(
      'Pre-modification snapshot',
      ['main.ts', 'generated.ts'],
      rootUri
    );

    // Modify file and create a new file
    fs.writeFileSync(targetFile, 'console.log("corrupted version");', 'utf-8');
    const createdFile = path.join(tempDir, 'generated.ts');
    fs.writeFileSync(createdFile, 'export const generated = true;', 'utf-8');

    assert.ok(fs.readFileSync(targetFile, 'utf-8').includes('corrupted version'));
    assert.ok(fs.existsSync(createdFile));

    // Execute rewind
    const rewindRes = await manager.rewindToCheckpoint(cpId, rootUri);

    assert.strictEqual(rewindRes.restoredFiles.length, 1);
    assert.strictEqual(rewindRes.restoredFiles[0], 'main.ts');
    assert.strictEqual(rewindRes.deletedCreatedFiles.length, 1);
    assert.strictEqual(rewindRes.deletedCreatedFiles[0], 'generated.ts');

    // Verify file content restored
    assert.strictEqual(fs.readFileSync(targetFile, 'utf-8'), 'console.log("initial version");');
    // Verify created file removed
    assert.strictEqual(fs.existsSync(createdFile), false);
  });

  it('should parse real repository git status and diff cleanly', async () => {
    const gitIntel = GitIntelligenceService.getInstance();
    const status = await gitIntel.getWorkingTreeStatus();

    assert.ok(typeof status.branch === 'string');
    assert.ok(typeof status.isClean === 'boolean');
    assert.ok(Array.isArray(status.files));
  });

  it('should run parametric benchmark regression verification on mock model with 100% pass rate', async () => {
    const mockOllama = {
      streamChat: async (
        model: string,
        messages: any[],
        onChunk: (chunk: string) => void,
        signal?: any,
        options?: any,
        timeouts?: any,
        onMetadata?: any
      ) => {
        onChunk('function getUserName(user) { return user?.name ?? "Guest"; }');
        if (onMetadata) {
          onMetadata({
            prompt_eval_count: 40,
            prompt_eval_duration: 1e9,
            eval_count: 20,
            eval_duration: 5e8
          });
        }
        return 'function getUserName(user) { return user?.name ?? "Guest"; }';
      }
    };

    const harness = new ParametricBenchmarkHarness(mockOllama as unknown as OllamaService);
    const regressionTask: BenchmarkTask = {
      id: 'repair-regression-01',
      name: 'Regression Null Check',
      category: 'code_repair',
      prompt: 'Fix getUserName',
      expectedOutputs: { mustContain: ['user?.name'] }
    };

    const result = await harness.runBenchmark(
      { model: 'qwen2.5-coder:7b', runs: 2 },
      { customCorpus: [regressionTask] }
    );

    assert.strictEqual(result.overallPassRate, 1.0);
    assert.strictEqual(result.passedTasks, 1);
    assert.strictEqual(result.failureTaxonomy.test_failure, 0);
    assert.strictEqual(result.failureTaxonomy.crash, 0);
  });
});
