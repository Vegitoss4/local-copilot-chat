import * as assert from 'assert';
import * as vscode from 'vscode';
import { AtomicFileWriter } from '../../src/services/atomicFileWriter';
import { resetMockState, mockFs, MockUri } from '../mocks/vscodeMock';

describe('Phase 5.5 H3: Shared AtomicFileWriter Service Suite', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(() => {
    resetMockState(testRoot);
  });

  it('should write data to target JSON file atomically via temp file and rename', async () => {
    const targetUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/test.json');
    const data = { hello: 'world', count: 42 };

    await AtomicFileWriter.writeJson(targetUri as any, data);

    const exists = await mockFs.readFile(targetUri);
    assert.ok(exists.length > 0, 'Target file must exist after atomic write');
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(exists));
    assert.deepStrictEqual(parsed, data);

    // Verify no temporary files remain in the directory
    const dirUri = MockUri.joinPath(targetUri, '..');
    const entries = await mockFs.readDirectory(dirUri);
    const tempFiles = entries.filter(([name]) => name.includes('.tmp.'));
    assert.strictEqual(tempFiles.length, 0, 'No temporary files should linger after successful write');
  });

  it('should serialize concurrent writes to the same file using mutex queue', async () => {
    const targetUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/concurrent.json');

    // Trigger 5 concurrent writes simultaneously
    const writes = [
      AtomicFileWriter.writeJson(targetUri as any, { step: 1 }),
      AtomicFileWriter.writeJson(targetUri as any, { step: 2 }),
      AtomicFileWriter.writeJson(targetUri as any, { step: 3 }),
      AtomicFileWriter.writeJson(targetUri as any, { step: 4 }),
      AtomicFileWriter.writeJson(targetUri as any, { step: 5 }),
    ];

    await Promise.all(writes);

    const content = await mockFs.readFile(targetUri);
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(content));
    assert.strictEqual(parsed.step, 5, 'Final state must reflect the last serialized write');

    const dirUri = MockUri.joinPath(targetUri, '..');
    const entries = await mockFs.readDirectory(dirUri);
    const tempFiles = entries.filter(([name]) => name.includes('.tmp.'));
    assert.strictEqual(tempFiles.length, 0, 'No temporary files should linger after concurrent writes');
  });

  it('should not wedge or poison the mutex queue if an earlier write operation fails', async () => {
    const targetUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/poison-test.json');

    // Simulate an initial write that fails by providing circular/unserializable data
    const circular: any = {};
    circular.self = circular;

    let failed = false;
    try {
      await AtomicFileWriter.writeJson(targetUri as any, circular);
    } catch {
      failed = true;
    }
    assert.strictEqual(failed, true, 'Circular object write must reject');

    // Subsequent write to the exact same URI MUST succeed
    await AtomicFileWriter.writeJson(targetUri as any, { recovered: true });
    const content = await mockFs.readFile(targetUri);
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(content));
    assert.strictEqual(parsed.recovered, true, 'Queue must process subsequent write cleanly');
  });

  it('should include process.pid in temporary file names to prevent multi-process collisions', () => {
    const targetUri = MockUri.file('C:/Projects/test-workspace/data.json');
    const tmpUri = (AtomicFileWriter as any).getTempUri(targetUri as any);
    assert.ok(tmpUri.fsPath.includes(`.${process.pid}.`), `Temp URI must include process.pid (${process.pid}), got: ${tmpUri.fsPath}`);
    assert.ok(tmpUri.fsPath.includes('.tmp.'), 'Temp URI must include .tmp marker');
  });

  it('should read valid JSON and fallback gracefully on missing file', async () => {
    const missingUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/missing.json');
    const fallback = { status: 'default' };

    const result = await AtomicFileWriter.readJson(missingUri as any, fallback);
    assert.deepStrictEqual(result, fallback, 'Should return fallback when file does not exist');
  });

  it('should create .corrupt backup file when reading malformed JSON and return fallback', async () => {
    const corruptUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/corrupt.json');
    await mockFs.createDirectory(MockUri.joinPath(corruptUri, '..'));
    await mockFs.writeFile(corruptUri, new TextEncoder().encode('{ invalid malformed json content ...'));

    const fallback = { recovered: true };
    const result = await AtomicFileWriter.readJson(corruptUri as any, fallback);
    assert.deepStrictEqual(result, fallback, 'Should return fallback when JSON is corrupted');

    const backupUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/corrupt.json.corrupt');
    const backupContent = await mockFs.readFile(backupUri);
    assert.ok(backupContent.length > 0, '.corrupt backup file must be created preserving original malformed content');
  });

  it('should clean up stale temporary files older than threshold', async () => {
    const dirUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot');
    await mockFs.createDirectory(dirUri);

    // Create an artificial stale temp file
    const staleTmpUri = MockUri.joinPath(dirUri, 'test.json.tmp.1234.1000000000.abc123');
    await mockFs.writeFile(staleTmpUri, new TextEncoder().encode('old temp data'));

    await AtomicFileWriter.cleanupStaleTempFiles(dirUri as any, 'test.json', 100); // 100ms threshold

    // Wait a brief moment and run cleanup
    await new Promise((r) => setTimeout(r, 120));
    await AtomicFileWriter.cleanupStaleTempFiles(dirUri as any, 'test.json', 50);

    const entries = await mockFs.readDirectory(dirUri);
    const staleFiles = entries.filter(([name]) => name.includes('.tmp.'));
    assert.strictEqual(staleFiles.length, 0, 'Stale temporary files must be cleaned up');
  });
});
