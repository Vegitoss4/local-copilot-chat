import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Local Copilot Extension Integration Test Suite', () => {
  vscode.window.showInformationMessage('Starting integration test suite...');

  test('Extension should be present in extensions list', () => {
    const ext = vscode.extensions.getExtension('local-developer.local-copilot-chat');
    assert.ok(ext, 'Expected extension to be discovered by VS Code');
  });

  test('Extension should register all contributed commands', async () => {
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
  });

  test('Extension configuration defaults should be registered', () => {
    const config = vscode.workspace.getConfiguration('localCopilot');
    const endpoint = config.get<string>('ollamaEndpoint');
    const defaultModel = config.get<string>('defaultModel');

    assert.strictEqual(endpoint, 'http://127.0.0.1:11434');
    assert.strictEqual(defaultModel, 'qwen2.5-coder:7b');
  });
});
