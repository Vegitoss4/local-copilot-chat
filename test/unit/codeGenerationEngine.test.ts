import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeGenerationEngine, FilePatchOperation } from '../../src/services/codeGenerationEngine';
import { resetMockState, mockFs, MockUri, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Phase 7.1: Hardened Code Generation Engine & Path Security Suite', () => {
  let engine: CodeGenerationEngine;
  const workspaceRoot = 'C:\\Projects\\test-workspace';
  const rootUri = MockUri.file(workspaceRoot);

  beforeEach(() => {
    resetMockState(workspaceRoot);
    setMockWorkspaceFolders([
      { name: 'test-workspace', uri: rootUri, index: 0 }
    ]);
    engine = new CodeGenerationEngine(rootUri as any);
  });

  afterEach(() => {
    resetMockState(workspaceRoot);
  });

  it('should apply multi-file transactional operations successfully within pinned workspace', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'utils.ts');
    const fileB = path.join(workspaceRoot, 'src', 'index.ts');

    mockFs.setFile(fileB, 'import { helper } from "./utils";\nconsole.log(oldTargetValue);');

    const ops: FilePatchOperation[] = [
      {
        filePath: 'src/utils.ts',
        type: 'create',
        content: 'export function newFn() { return 42; }'
      },
      {
        filePath: 'src/index.ts',
        type: 'modify',
        oldString: 'oldTargetValue',
        newString: 'newFn()'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.appliedOperations, 2);
    assert.strictEqual(result.rolledBack, false);

    assert.strictEqual(mockFs.getFile(fileA), 'export function newFn() { return 42; }');
    assert.strictEqual(mockFs.getFile(fileB), 'import { helper } from "./utils";\nconsole.log(newFn());');
  });

  it('should strictly reject operations attempting directory traversal outside workspace', async () => {
    const ops: FilePatchOperation[] = [
      {
        filePath: '../../outside.ts',
        type: 'create',
        content: 'malicious payload'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.ok(result.error?.includes('traversal sequences') || result.error?.includes('outside the authorized workspace'));
  });

  it('should strictly reject absolute paths pointing outside pinned workspace', async () => {
    const ops: FilePatchOperation[] = [
      {
        filePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
        type: 'modify',
        oldString: '127.0.0.1',
        newString: '0.0.0.0'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.ok(result.error?.includes('outside the authorized workspace'));
  });

  it('should strictly reject access to internal state (.vscode/local-copilot)', async () => {
    const ops: FilePatchOperation[] = [
      {
        filePath: '.vscode/local-copilot/memory.json',
        type: 'modify',
        content: '{}'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.ok(result.error?.includes('internal extension state'));
  });

  it('should rollback cleanly without conflicts when a surgical replacement target is not found', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'created.ts');
    const fileB = path.join(workspaceRoot, 'src', 'existing.ts');

    const originalContentB = 'const initialValue = 100;';
    mockFs.setFile(fileB, originalContentB);

    const ops: FilePatchOperation[] = [
      {
        filePath: 'src/created.ts',
        type: 'create',
        content: 'export const created = true;'
      },
      {
        filePath: 'src/existing.ts',
        type: 'modify',
        oldString: 'nonExistentString',
        newString: 'replacement'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.ok(result.error?.includes('target string not found'));

    // fileA should have been rolled back (deleted)
    assert.strictEqual(mockFs.getFile(fileA), undefined);
    // fileB should remain unchanged
    assert.strictEqual(mockFs.getFile(fileB), originalContentB);
  });

  it('should preserve external user edits during rollback and report conflict for modified files', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'shared.ts');
    const originalContent = 'export const initial = 1;';
    mockFs.setFile(fileA, originalContent);

    // Create an engine with a verification hook that mutates the file externally before failing
    const ops: FilePatchOperation[] = [
      {
        filePath: 'src/shared.ts',
        type: 'modify',
        oldString: 'initial = 1',
        newString: 'initial = 2'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops, async () => {
      // Simulate user editing the file in VS Code while transaction was in flight
      mockFs.setFile(fileA, 'export const initial = 999; // User concurrent edit');
      return { valid: false, error: 'Type check failed' };
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.ok(result.conflicts && result.conflicts.length > 0);
    assert.ok(result.conflicts[0].includes('modified externally during transaction'));

    // User edits must NOT be clobbered
    assert.strictEqual(mockFs.getFile(fileA), 'export const initial = 999; // User concurrent edit');
  });

  it('should preserve newly created file on rollback if modified externally and report conflict', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'newFile.ts');

    const ops: FilePatchOperation[] = [
      {
        filePath: 'src/newFile.ts',
        type: 'create',
        content: 'initial generated text'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops, async () => {
      // User modifies the new file externally before transaction finishes
      mockFs.setFile(fileA, 'initial generated text + external edit');
      return { valid: false, error: 'Verification failed' };
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.ok(result.conflicts && result.conflicts.length > 0);
    assert.ok(result.conflicts[0].includes('modified externally after creation'));

    // External file must NOT be deleted
    assert.strictEqual(mockFs.getFile(fileA), 'initial generated text + external edit');
  });

  it('should refuse to patch a file that has unsaved dirty editor modifications', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'dirty.ts');
    mockFs.setFile(fileA, 'const x = 1;');

    const dirtyDoc = {
      uri: MockUri.file(fileA),
      isDirty: true,
      getText: () => 'const x = 2; // unsaved'
    };
    (vscode.workspace as any).textDocuments = [dirtyDoc];

    try {
      const ops: FilePatchOperation[] = [
        {
          filePath: 'src/dirty.ts',
          type: 'modify',
          content: 'const x = 3;'
        }
      ];

      const result = await engine.applyTransactionalPatches(ops);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.rolledBack, true);
      assert.ok(result.error?.includes('unsaved editor modifications'));
      assert.strictEqual(mockFs.getFile(fileA), 'const x = 1;');
    } finally {
      (vscode.workspace as any).textDocuments = [];
    }
  });

  it('should match and preserve CRLF line endings in surgical search replace', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'crlf.ts');
    mockFs.setFile(fileA, 'line 1\r\nline 2 target\r\nline 3\r\n');

    // Op uses LF line endings in oldString and newString
    const ops: FilePatchOperation[] = [
      {
        filePath: 'src/crlf.ts',
        type: 'modify',
        oldString: 'line 2 target\n',
        newString: 'line 2 replaced\n'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);
    assert.strictEqual(result.success, true);
    const content = mockFs.getFile(fileA);
    assert.strictEqual(content, 'line 1\r\nline 2 replaced\r\nline 3\r\n');
  });

  it('should recover interrupted transaction from on-disk journal', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'uncommitted.ts');
    mockFs.setFile(fileA, 'corrupt half-written state');

    const journalUri = vscode.Uri.joinPath(rootUri as any, '.vscode', 'local-copilot', 'tx-journal.json');
    const journalContent = {
      txId: 'tx-crash-test',
      timestamp: Date.now(),
      entries: [
        {
          uriString: MockUri.file(fileA).toString(),
          normPath: path.normalize(fileA),
          initialExists: true,
          initialContentBase64: Buffer.from('original clean state').toString('base64')
        }
      ]
    };
    mockFs.setFile(journalUri.fsPath, JSON.stringify(journalContent));

    const rec = await CodeGenerationEngine.recoverInterruptedTransaction(rootUri as any);
    assert.strictEqual(rec.recovered, true);
    assert.strictEqual(rec.filesRolledBack.length, 1);
    assert.strictEqual(mockFs.getFile(fileA), 'original clean state');
    assert.strictEqual(mockFs.getFile(journalUri.fsPath), undefined);
  });

  it('should allow sequential multi-step modifications to the same file in a single transaction', async () => {
    const fileA = path.join(workspaceRoot, 'src', 'multi-step.ts');
    mockFs.setFile(fileA, 'const x = 1;\nconst y = 2;\n');

    const ops: FilePatchOperation[] = [
      {
        filePath: 'src/multi-step.ts',
        type: 'modify',
        oldString: 'const x = 1;\n',
        newString: 'const x = 100;\n'
      },
      {
        filePath: 'src/multi-step.ts',
        type: 'modify',
        oldString: 'const y = 2;\n',
        newString: 'const y = 200;\n'
      }
    ];

    const result = await engine.applyTransactionalPatches(ops);
    assert.strictEqual(result.success, true);
    const content = mockFs.getFile(fileA);
    assert.strictEqual(content, 'const x = 100;\nconst y = 200;\n');
  });
});
