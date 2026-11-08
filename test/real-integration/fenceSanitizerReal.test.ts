import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { stripMarkdownFences, assertNoFenceLines } from '../../src/services/fenceSanitizer';
import { CodeGenerationEngine } from '../../src/services/codeGenerationEngine';
import { resetMockState, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Scoped Fix: Real Filesystem Fence Sanitization & Disk Integrity Suite', function () {
  this.timeout(10000);

  let tempDir: string;
  let originalFs: any;
  let rootUri: vscode.Uri;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-real-'));
    rootUri = vscode.Uri.file(tempDir);
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { uri: rootUri, name: 'fence-test-ws', index: 0 },
    ]);
    originalFs = vscode.workspace.fs;

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
      async delete(uri: vscode.Uri) {
        if (fs.existsSync(uri.fsPath)) {
          await fs.promises.unlink(uri.fsPath);
        }
      },
      async rename(src: vscode.Uri, dest: vscode.Uri) {
        const destDir = path.dirname(dest.fsPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        await fs.promises.rename(src.fsPath, dest.fsPath);
      },
    };
  });

  afterEach(() => {
    (vscode.workspace as any).fs = originalFs;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should write sanitized C# controller to real disk with zero backtick characters', async () => {
    const rawModelOutput = `\`\`\`csharp
namespace Backend.Api.Controllers;

public class TaskItemsController
{
    public string Name { get; set; } = "Task";
}
\`\`\``;

    const relPath = 'Controllers/TaskItemsController.cs';
    const targetFile = path.join(tempDir, relPath);

    const { sanitized } = stripMarkdownFences(rawModelOutput, relPath);
    assertNoFenceLines(sanitized, relPath);

    const engine = new CodeGenerationEngine(rootUri);
    const result = await engine.applyTransactionalPatches([
      {
        filePath: relPath,
        type: 'create',
        content: sanitized,
      },
    ]);

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.success, true);
    assert.strictEqual(fs.existsSync(targetFile), true);

    const diskContent = fs.readFileSync(targetFile, 'utf-8');
    assert.ok(!diskContent.includes('```'));
    assert.ok(diskContent.startsWith('namespace Backend.Api.Controllers;'));
    assert.ok(diskContent.includes('public class TaskItemsController'));
  });

  it('should write README.md with internal code fences intact to real disk', async () => {
    const readmeContent = `# Project Guide

\`\`\`bash
npm install
npm test
\`\`\`

Done.`;

    const relPath = 'README.md';
    const targetFile = path.join(tempDir, relPath);

    const { sanitized } = stripMarkdownFences(readmeContent, relPath);
    assertNoFenceLines(sanitized, relPath);

    const engine = new CodeGenerationEngine(rootUri);
    const result = await engine.applyTransactionalPatches([
      {
        filePath: relPath,
        type: 'create',
        content: sanitized,
      },
    ]);

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.success, true);
    assert.strictEqual(fs.existsSync(targetFile), true);

    const diskContent = fs.readFileSync(targetFile, 'utf-8');
    assert.ok(diskContent.includes('```bash\nnpm install\nnpm test\n```'));
  });
});
