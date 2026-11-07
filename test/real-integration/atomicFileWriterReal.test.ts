import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AtomicFileWriter } from '../../src/services/atomicFileWriter';
import { mockFs } from '../mocks/vscodeMock';

describe('Phase 8.1f: Real Filesystem AtomicFileWriter Concurrency & Disk Resilience Tier', function () {
  this.timeout(10000);

  let tempDir: string;
  let originalFs: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-real-'));
    originalFs = vscode.workspace.fs;

    // Real OS filesystem bridge for vscode.workspace.fs
    (vscode.workspace as any).fs = {
      async createDirectory(uri: vscode.Uri) {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
      },
      async writeFile(uri: vscode.Uri, content: Uint8Array) {
        await fs.promises.writeFile(uri.fsPath, Buffer.from(content));
      },
      async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const buf = await fs.promises.readFile(uri.fsPath);
        return new Uint8Array(buf);
      },
      async rename(src: vscode.Uri, dest: vscode.Uri, options?: { overwrite?: boolean }) {
        if (!options?.overwrite && fs.existsSync(dest.fsPath)) {
          throw new Error(`Target already exists: ${dest.fsPath}`);
        }
        await fs.promises.rename(src.fsPath, dest.fsPath);
      },
      async delete(uri: vscode.Uri, _options?: { useTrash?: boolean }) {
        await fs.promises.rm(uri.fsPath, { force: true, recursive: true });
      },
      async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const s = await fs.promises.stat(uri.fsPath);
        return {
          type: s.isDirectory() ? 2 : 1,
          ctime: s.birthtimeMs,
          mtime: s.mtimeMs,
          size: s.size
        };
      },
      async readDirectory(uri: vscode.Uri): Promise<Array<[string, number]>> {
        const dirents = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return dirents.map((d) => [d.name, d.isDirectory() ? 2 : 1]);
      }
    };
  });

  afterEach(() => {
    (vscode.workspace as any).fs = originalFs;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  });

  it('should serialize 20 concurrent real disk writes without data corruption or EBUSY races', async () => {
    const targetFile = path.join(tempDir, 'state.json');
    const targetUri = vscode.Uri.file(targetFile);

    // Concurrently trigger 20 writes to the same file
    const writePromises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writePromises.push(
        AtomicFileWriter.writeJson(targetUri, {
          iteration: i,
          payload: `data-chunk-${i}`.repeat(50),
          writtenAt: Date.now()
        })
      );
    }

    // All 20 must resolve cleanly without file-lock collisions
    await Promise.all(writePromises);

    // Verify real file on disk is valid JSON
    assert.strictEqual(fs.existsSync(targetFile), true);
    const content = fs.readFileSync(targetFile, 'utf8');
    const parsed = JSON.parse(content);
    assert.ok(typeof parsed.iteration === 'number');
    assert.ok(parsed.payload.startsWith('data-chunk-'));
  });

  it('should create .corrupt backup on real filesystem when recovering from malformed JSON', async () => {
    const targetFile = path.join(tempDir, 'corrupt.json');
    const targetUri = vscode.Uri.file(targetFile);

    // Write malformed JSON directly to real disk
    fs.writeFileSync(targetFile, '{"unfinished_json": [1, 2, ', 'utf8');

    const fallback = { fallback: true };
    const result = await AtomicFileWriter.readJson(targetUri, fallback);

    assert.deepStrictEqual(result, fallback);

    // Verify .corrupt file exists on real disk
    const corruptFile = path.join(tempDir, 'corrupt.json.corrupt');
    assert.strictEqual(fs.existsSync(corruptFile), true);
    const corruptContent = fs.readFileSync(corruptFile, 'utf8');
    assert.strictEqual(corruptContent, '{"unfinished_json": [1, 2, ');
  });

  it('should clean up stale temporary files older than threshold on real filesystem', async () => {
    const dirUri = vscode.Uri.file(tempDir);
    const staleTimestamp = Date.now() - 120000;
    const staleTmp = path.join(tempDir, `state.json.tmp.9999.${staleTimestamp}.old`);
    fs.writeFileSync(staleTmp, 'stale temp data', 'utf8');

    // Active temp file (fresh timestamp)
    const freshTimestamp = Date.now();
    const freshTmp = path.join(tempDir, `state.json.tmp.9999.${freshTimestamp}.fresh`);
    fs.writeFileSync(freshTmp, 'fresh temp data', 'utf8');

    await AtomicFileWriter.cleanupStaleTempFiles(dirUri, 'state.json', 60000);

    // Stale tmp must be deleted
    assert.strictEqual(fs.existsSync(staleTmp), false, 'Stale temp file was not deleted');
    // Fresh tmp must be preserved
    assert.strictEqual(fs.existsSync(freshTmp), true, 'Fresh temp file was mistakenly deleted');
  });
});
