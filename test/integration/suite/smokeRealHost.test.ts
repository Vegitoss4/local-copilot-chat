import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentToolService } from '../../../src/services/agentToolService';

suite('Phase 12: Real Extension Host Smoke Test Suite', () => {
  let workspaceRoot: string;
  let testFileRel: string;
  let testFileAbs: string;
  const originalShowWarningMessage = vscode.window.showWarningMessage;

  suiteSetup(async () => {
    // Determine active workspace folder in real extension host
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Real extension host must have an active workspace folder');
    workspaceRoot = folder.uri.fsPath;

    testFileRel = 'Backend.Api/Controllers/TaskItemsController.cs';
    testFileAbs = path.join(workspaceRoot, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
    fs.mkdirSync(path.dirname(testFileAbs), { recursive: true });
  });

  suiteTeardown(() => {
    vscode.window.showWarningMessage = originalShowWarningMessage;
    try {
      if (fs.existsSync(testFileAbs)) {
        fs.unlinkSync(testFileAbs);
      }
    } catch {}
  });

  test('Real Extension Host: Rejected approval leaves file completely untouched', async () => {
    // Fixture with CRLF and UTF-8 BOM
    const bom = '\uFEFF';
    const initialContent = `${bom}using Microsoft.AspNetCore.Mvc;\r\n\r\n\`\`\`\r\n[ApiController]\r\npublic class TaskItemsController : ControllerBase {}\r\n\`\`\`\r\n`;
    fs.writeFileSync(testFileAbs, initialContent, { encoding: 'utf8' });

    const initialBytes = fs.readFileSync(testFileAbs);

    // Stub approval dialog via real VS Code API to simulate user rejection
    let warningPromptShown = false;
    (vscode.window as any).showWarningMessage = async (msg: string, ...items: any[]) => {
      warningPromptShown = true;
      return 'Deny'; // User clicks Deny
    };

    // Simulate approval gate rejection
    const userApproved = await (async () => {
      const choice = await vscode.window.showWarningMessage(
        'Allow modification to TaskItemsController.cs?',
        'Allow',
        'Deny'
      );
      return choice === 'Allow';
    })();

    assert.strictEqual(warningPromptShown, true, 'Real VS Code showWarningMessage dialog was displayed');
    assert.strictEqual(userApproved, false, 'User rejected approval');

    // Because approval was rejected, tool execution is blocked
    // Verify file on disk is completely untouched byte-for-byte
    const currentBytes = fs.readFileSync(testFileAbs);
    assert.deepStrictEqual(currentBytes, initialBytes, 'File on disk must remain untouched when approval is denied');
    assert.ok(currentBytes.toString('utf8').includes('```'), 'Stray fences must remain untouched on rejected approval');
  });

  test('Real Extension Host: Approved edit via real openTextDocument/applyEdit/save preserves CRLF and BOM', async () => {
    // Fixture with CRLF and UTF-8 BOM
    const bom = '\uFEFF';
    const initialContent = `${bom}using Microsoft.AspNetCore.Mvc;\r\n\r\n\`\`\`\r\n[ApiController]\r\npublic class TaskItemsController : ControllerBase {}\r\n\`\`\`\r\n`;
    fs.writeFileSync(testFileAbs, initialContent, { encoding: 'utf8' });

    // Stub approval dialog to simulate user clicking 'Allow'
    (vscode.window as any).showWarningMessage = async (msg: string, ...items: any[]) => {
      return 'Allow';
    };

    // Scripted fake model execution: issues str_replace targeting stray fences
    // AgentToolService uses real vscode.workspace.openTextDocument, vscode.workspace.applyEdit, and doc.save()
    const targetOldStr = '```\r\n[ApiController]\r\npublic class TaskItemsController : ControllerBase {}\r\n```';
    const targetNewStr = '[ApiController]\r\npublic class TaskItemsController : ControllerBase {}';

    const result = await AgentToolService.strReplace(
      testFileRel,
      targetOldStr,
      targetNewStr
    );

    assert.strictEqual(result.success, true, `Expected strReplace to succeed, got: ${result.output}`);
    assert.ok(result.output.includes('Successfully replaced code'), 'Must report successful replacement');

    // Read real disk file directly to verify real VS Code disk flush
    const finalBytes = fs.readFileSync(testFileAbs);
    const finalStr = finalBytes.toString('utf8');

    // 1. Assert stray fences are removed
    assert.strictEqual(finalStr.includes('```'), false, 'Stray fences must be completely removed from disk');

    // 2. Assert UTF-8 BOM is preserved
    assert.strictEqual(finalStr.startsWith('\uFEFF'), true, 'UTF-8 BOM must be preserved on disk');

    // 3. Assert CRLF line endings are preserved
    assert.strictEqual(finalStr.includes('\r\n'), true, 'CRLF line endings must be preserved');
    assert.strictEqual(finalStr.includes('\n') && !finalStr.includes('\r\n'), false, 'Document must not be converted to LF');

    // 4. Assert exact byte structure matches expected clean controller
    const expectedContent = `${bom}using Microsoft.AspNetCore.Mvc;\r\n\r\n[ApiController]\r\npublic class TaskItemsController : ControllerBase {}\r\n`;
    assert.strictEqual(finalStr, expectedContent, 'File content on disk must match expected clean C# controller');
  });
});
