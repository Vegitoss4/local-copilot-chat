import * as assert from 'assert';
import * as vscode from 'vscode';
import { AgentToolService } from '../../../src/services/agentToolService';

suite('Local Copilot Extension Integration Test Suite', () => {
  vscode.window.showInformationMessage('Starting integration test suite...');

  test('Extension should be present in extensions list', () => {
    const ext = vscode.extensions.getExtension('local-developer.local-copilot-chat');
    assert.ok(ext, 'Expected extension to be discovered by VS Code');
  });

  test('Extension should register all contributed commands and execute focus command', async () => {
    const ext = vscode.extensions.getExtension('local-developer.local-copilot-chat');
    assert.ok(ext, 'Expected extension to be discovered by VS Code');
    if (!ext.isActive) {
      await ext.activate();
    }

    const allCommands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      'localCopilotChat.focus',
      'localCopilotChat.explainCode',
      'localCopilotChat.refactorCode'
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        allCommands.includes(cmd),
        `Expected command "${cmd}" to be registered in VS Code`
      );
    }

    // Execute contributed command in extension host
    try {
      await vscode.commands.executeCommand('localCopilotChat.focus');
    } catch {
      // Focus command executes view focus which may be headless in tests
    }
  });

  test('Extension configuration defaults should be registered', () => {
    const config = vscode.workspace.getConfiguration('localCopilot');
    const endpoint = config.get<string>('ollamaEndpoint');
    const defaultModel = config.get<string>('defaultModel');

    assert.strictEqual(endpoint, 'http://127.0.0.1:11434');
    assert.strictEqual(defaultModel, 'qwen2.5-coder:7b');
  });

  test('Real Extension Host: Filesystem tool handlers reject path traversal and protect internal state', async () => {
    // 1. Traversal rejection in real extension host
    const traversalRead = await AgentToolService.viewFileRange('../../sensitive_host_file.txt', 1, 5);
    assert.match(traversalRead, /Access Denied/i);

    const traversalCreate = await AgentToolService.createFile('../../escaped_payload.txt', 'malicious');
    assert.strictEqual(traversalCreate.success, false);
    assert.match(traversalCreate.output, /Access Denied/i);

    // 2. Internal state protection in real extension host
    const stateTampering = await AgentToolService.createFile('.vscode/local-copilot/memory.json', '{"hacked": true}');
    assert.strictEqual(stateTampering.success, false);
    assert.match(stateTampering.output, /Access Denied: Cannot access internal extension state/i);
  });
});
