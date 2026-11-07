import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CheckpointManager,
  CheckpointManifest,
  RewindResult
} from '../../src/services/checkpointManager';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 11.5: Content-Addressed Local Checkpoints & File Rewind Suite', () => {
  let manager: CheckpointManager;
  const tempDir = 'C:\\Projects\\test-workspace';
  const rootUri = MockUri.file(tempDir);

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'checkpoint-workspace', uri: rootUri, index: 0 }
    ]);
    manager = CheckpointManager.getInstance();
  });

  describe('SHA-256 Content-Addressed Hashing', () => {
    it('should compute deterministic SHA-256 hash for byte buffers', () => {
      const data = new TextEncoder().encode('Hello Checkpoint World');
      const hash1 = CheckpointManager.computeSha256(data);
      const hash2 = CheckpointManager.computeSha256(data);

      assert.strictEqual(hash1, hash2);
      assert.strictEqual(hash1.length, 64);
      assert.strictEqual(
        hash1,
        '31547e9cbed7b64efb0aa71fc87044b3d072bea9e2c5a2970ea049856be13ef0'
      );
    });
  });

  describe('Checkpoint Creation & Blob Deduplication', () => {
    it('should create checkpoint for existing and newly created files', async () => {
      const file1Uri = vscode.Uri.joinPath(rootUri, 'src', 'app.ts');
      await vscode.workspace.fs.writeFile(file1Uri, new TextEncoder().encode('const initialApp = 1;'));

      const cpId = await manager.createCheckpoint(
        'Pre-refactor snapshot',
        ['src/app.ts', 'src/newService.ts'],
        rootUri
      );

      assert.ok(cpId.startsWith('cp_'));

      const list = await manager.listCheckpoints(rootUri);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].checkpointId, cpId);
      assert.strictEqual(list[0].description, 'Pre-refactor snapshot');
      assert.strictEqual(list[0].fileCount, 2);
    });
  });

  describe('File Rewind Execution', () => {
    it('should restore modified files and delete newly created files on rewind', async () => {
      const file1Uri = vscode.Uri.joinPath(rootUri, 'src', 'index.ts');
      const originalContent = 'export const version = "1.0.0";';
      await vscode.workspace.fs.writeFile(file1Uri, new TextEncoder().encode(originalContent));

      // 1. Create checkpoint before modification
      const cpId = await manager.createCheckpoint(
        'Before feature addition',
        ['src/index.ts', 'src/helper.ts'],
        rootUri
      );

      // 2. Simulate agent turn making modifications and creating a new file
      await vscode.workspace.fs.writeFile(file1Uri, new TextEncoder().encode('export const version = "2.0.0-broken";'));
      const newFileUri = vscode.Uri.joinPath(rootUri, 'src', 'helper.ts');
      await vscode.workspace.fs.writeFile(newFileUri, new TextEncoder().encode('export const helper = true;'));

      // Verify files are modified
      const modifiedBytes = await vscode.workspace.fs.readFile(file1Uri);
      assert.ok(new TextDecoder().decode(modifiedBytes).includes('2.0.0-broken'));

      // 3. Rewind to checkpoint
      const result: RewindResult = await manager.rewindToCheckpoint(cpId, rootUri);

      assert.strictEqual(result.checkpointId, cpId);
      assert.strictEqual(result.restoredFiles.length, 1);
      assert.strictEqual(result.restoredFiles[0], 'src/index.ts');
      assert.strictEqual(result.deletedCreatedFiles.length, 1);
      assert.strictEqual(result.deletedCreatedFiles[0], 'src/helper.ts');
      assert.strictEqual(result.errors.length, 0);

      // 4. Verify restored contents
      const restoredBytes = await vscode.workspace.fs.readFile(file1Uri);
      assert.strictEqual(new TextDecoder().decode(restoredBytes), originalContent);

      // 5. Verify created file was deleted
      let helperExists = true;
      try {
        await vscode.workspace.fs.readFile(newFileUri);
      } catch {
        helperExists = false;
      }
      assert.strictEqual(helperExists, false);
    });
  });
});
