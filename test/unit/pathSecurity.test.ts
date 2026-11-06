import * as assert from 'assert';
import * as path from 'path';
import { AgentToolService } from '../../src/services/agentToolService';
import { resetMockState, mockState } from '../mocks/vscodeMock';

describe('Path Resolution & Security Containment Baseline', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(() => {
    resetMockState(testRoot);
  });

  it('should resolve standard relative paths within workspace root', () => {
    const relPath = 'Backend.Api/Program.cs';
    const uri = AgentToolService.getFileUri(relPath);
    const expected = path.normalize(path.join(testRoot, relPath));
    assert.strictEqual(uri.fsPath, expected);
  });

  it('should strip leading slashes and backslashes', () => {
    const uri1 = AgentToolService.getFileUri('/src/index.ts');
    assert.strictEqual(uri1.fsPath, path.normalize(path.join(testRoot, 'src/index.ts')));

    const uri2 = AgentToolService.getFileUri('\\src\\index.ts');
    assert.strictEqual(uri2.fsPath, path.normalize(path.join(testRoot, 'src/index.ts')));
  });

  it('should handle Windows-style backslash relative paths', () => {
    const relPath = 'Frontend.Client\\src\\app\\app.component.ts';
    const uri = AgentToolService.getFileUri(relPath);
    const expected = path.normalize(path.join(testRoot, 'Frontend.Client/src/app/app.component.ts'));
    assert.strictEqual(uri.fsPath, expected);
  });

  // PENDING SECURITY TEST: Current implementation does NOT check bounds and permits ../../ traversal
  it.skip('[PENDING SECURITY FIX - PHASE 1] should reject path traversal attempts outside workspace root', () => {
    const maliciousPaths = [
      '../../Windows/System32/cmd.exe',
      '../../../etc/passwd',
      '..\\..\\sensitive.env',
      'subfolder/../../outside.txt'
    ];

    for (const p of maliciousPaths) {
      assert.throws(
        () => AgentToolService.getFileUri(p),
        /Security Violation|outside workspace/i,
        `Expected traversal path "${p}" to be rejected`
      );
    }
  });
});
