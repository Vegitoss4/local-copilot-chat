import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceManager } from '../../src/services/workspaceManager';
import { MemoryService } from '../../src/services/memoryService';
import { SwarmOrchestrator } from '../../src/services/swarmOrchestrator';
import { OllamaService } from '../../src/services/ollamaService';
import { PathSecurity } from '../../src/services/pathSecurity';
import { resetMockState, MockUri, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Phase 5.5 H4.3: Multi-Root Workspace Isolation Suite', () => {
  const folderAUri = MockUri.file('C:/Projects/multi-root-a');
  const folderBUri = MockUri.file('C:/Projects/multi-root-b');

  beforeEach(() => {
    resetMockState('C:/Projects/multi-root-a');
    setMockWorkspaceFolders([
      { name: 'frontend-a', uri: folderAUri, index: 0 },
      { name: 'backend-b', uri: folderBUri, index: 1 },
    ]);
  });

  describe('1. WorkspaceManager Root Resolution Hierarchy', () => {
    it('should resolve primary folder when single root is open', () => {
      setMockWorkspaceFolders([{ name: 'single-project', uri: folderAUri, index: 0 }]);

      const folder = WorkspaceManager.getTargetWorkspaceFolder();
      assert.ok(folder);
      assert.strictEqual(folder?.name, 'single-project');
      assert.strictEqual(folder?.uri.fsPath, folderAUri.fsPath);
    });

    it('should resolve target root by preferredUri in multi-root workspace', () => {
      const fileInB = MockUri.file('C:/Projects/multi-root-b/src/server.ts');
      const folder = WorkspaceManager.getTargetWorkspaceFolder(fileInB as any);

      assert.ok(folder);
      assert.strictEqual(folder?.name, 'backend-b');
      assert.strictEqual(folder?.uri.fsPath, folderBUri.fsPath);
    });

    it('should resolve target root based on active text editor document', () => {
      const docInB = {
        uri: MockUri.file('C:/Projects/multi-root-b/package.json'),
      };
      (vscode.window as any).activeTextEditor = { document: docInB };

      const folder = WorkspaceManager.getTargetWorkspaceFolder();
      assert.ok(folder);
      assert.strictEqual(folder?.name, 'backend-b');
      assert.strictEqual(folder?.uri.fsPath, folderBUri.fsPath);

      (vscode.window as any).activeTextEditor = undefined;
    });

    it('should fall back to primary folder when no active editor or preferred URI is provided', () => {
      (vscode.window as any).activeTextEditor = undefined;

      const folder = WorkspaceManager.getTargetWorkspaceFolder();
      assert.ok(folder);
      assert.strictEqual(folder?.name, 'frontend-a', 'Should fallback to workspaceFolders[0]');
    });

    it('should isolate storage paths cleanly to per-folder .vscode/local-copilot/ directories', () => {
      const folderA: any = { uri: folderAUri, name: 'frontend-a' };
      const folderB: any = { uri: folderBUri, name: 'backend-b' };

      const storageA = WorkspaceManager.getStorageUri(folderA, 'chat_history.json');
      const storageB = WorkspaceManager.getStorageUri(folderB, 'chat_history.json');

      assert.ok(storageA.fsPath.includes('multi-root-a'));
      assert.ok(storageB.fsPath.includes('multi-root-b'));
      assert.notStrictEqual(storageA.fsPath, storageB.fsPath);
    });
  });

  describe('2. Memory & RAG Retrieval Isolation', () => {
    it('should isolate memory chunks to queried root and prevent cross-project contamination', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const memory = MemoryService.getInstance(ollama);
      await memory.clear();

      // Add chunk from Project A
      await memory.indexFile(
        'C:/Projects/multi-root-a/src/App.tsx',
        'Frontend React component architecture and hooks'
      );

      // Add chunk from Project B
      await memory.indexFile(
        'C:/Projects/multi-root-b/Program.cs',
        'Backend ASP.NET Core database connection string and entity configuration'
      );

      // Search scoped to Project B root
      const resultsB = await memory.semanticSearch('database connection', 5, 'all', folderBUri as any);
      assert.ok(resultsB.length > 0, 'Should return results for backend');
      for (const res of resultsB) {
        assert.ok(
          res.chunk.metadata.filePath?.includes('multi-root-b'),
          `Chunk should belong strictly to Project B but got: ${res.chunk.metadata.filePath}`
        );
      }
    });
  });

  describe('3. Swarm Whiteboard Isolation & Pinning', () => {
    it('should isolate whiteboard storage to pinned workspace root in multi-root workspace', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');

      const swarmB = new SwarmOrchestrator(ollama, {
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
        workspaceRootUri: folderBUri as any,
      });

      // Private getter check via casting
      const fileUri = (swarmB as any).getWhiteboardFileUri();
      assert.ok(fileUri, 'Whiteboard URI must exist');
      assert.ok(fileUri.fsPath.includes('multi-root-b'), `Whiteboard must be stored in Project B: ${fileUri.fsPath}`);
      assert.ok(fileUri.fsPath.endsWith('whiteboard.json'));
    });
  });

  describe('4. Pinned Workspace Path Validation & App Generator Multi-Root', () => {
    it('should resolve unqualified relative paths against pinned folder in multi-root workspace', () => {
      const validated = PathSecurity.validatePath('src/index.ts', folderBUri as any);
      assert.ok(validated.uri.fsPath.includes('multi-root-b'));
      assert.strictEqual(validated.folder.name, 'backend-b');
    });

    it('should reject path outside pinned folder even if it belongs to another open workspace folder', () => {
      assert.throws(
        () => {
          PathSecurity.validatePath('C:/Projects/multi-root-a/src/index.ts', folderBUri as any);
        },
        (err: any) => {
          assert.match(err.message, /Access Denied: Path .* resolves outside the authorized workspace/);
          return true;
        }
      );
    });
  });

  describe('5. State Storage & Git Hygiene Enforcement', () => {
    it('should create .vscode/local-copilot/.gitignore to isolate internal state from source control', async () => {
      const folderA = { name: 'frontend-a', uri: folderAUri, index: 0 };
      await WorkspaceManager.ensureStorageHygiene(folderA as any);

      const gitignoreUri = vscode.Uri.joinPath(WorkspaceManager.getStorageUri(folderA as any), '.gitignore');
      const gitignoreContent = await vscode.workspace.fs.readFile(gitignoreUri);
      const text = Buffer.from(gitignoreContent).toString('utf8');

      assert.ok(text.includes('*'));
      assert.ok(text.includes('!.gitignore'));
    });
  });
});
