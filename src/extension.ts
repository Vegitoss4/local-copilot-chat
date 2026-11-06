import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Local Copilot');
  context.subscriptions.push(outputChannel);
  outputChannel.show(true);
  outputChannel.appendLine('[Extension] Local Copilot Chat activating...');

  const config = vscode.workspace.getConfiguration('localCopilot');
  const ollamaEndpoint = config.get<string>('ollamaEndpoint') || 'http://127.0.0.1:11434';

  const ollamaService = new OllamaService(ollamaEndpoint);
  const provider = new ChatViewProvider(context.extensionUri, ollamaService, outputChannel);

  outputChannel.appendLine(`[Extension] Ollama configured at: ${ollamaEndpoint}`);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localCopilot.ollamaEndpoint')) {
        const newEndpoint = vscode.workspace
          .getConfiguration('localCopilot')
          .get<string>('ollamaEndpoint') || 'http://127.0.0.1:11434';
        ollamaService.setEndpoint(newEndpoint);
      }
    })
  );

  // Command: Focus Chat
  context.subscriptions.push(
    vscode.commands.registerCommand('localCopilotChat.focus', () => {
      vscode.commands.executeCommand('localCopilotChat.chatView.focus');
    })
  );

  // Command: Explain Selected Code
  context.subscriptions.push(
    vscode.commands.registerCommand('localCopilotChat.explainCode', () => {
      provider.sendCodePrompt('Please explain what this code does and highlight any potential bugs or edge cases');
    })
  );

  // Command: Refactor Selected Code
  context.subscriptions.push(
    vscode.commands.registerCommand('localCopilotChat.refactorCode', () => {
      provider.sendCodePrompt('Please refactor this code to improve readability, efficiency, and adhere to best practices');
    })
  );
}

export function deactivate() {}
