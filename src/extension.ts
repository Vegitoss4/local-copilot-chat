import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { ChatViewProvider } from './chatViewProvider';
import { ConfigurationService } from './services/configurationService';
import { WorkspaceManager } from './services/workspaceManager';
import { CodeGenerationEngine } from './services/codeGenerationEngine';
import { ModelLifecycleManager } from './services/modelLifecycleManager';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Jarvis');
  context.subscriptions.push(outputChannel);
  outputChannel.show(true);
  outputChannel.appendLine('[Extension] Jarvis activating build v0.2.0 (compiled 2026-11-10)...');

  const configService = ConfigurationService.getInstance();
  context.subscriptions.push(configService);

  const ollamaEndpoint = configService.ollamaEndpoint;
  const ollamaService = new OllamaService(ollamaEndpoint);
  ModelLifecycleManager.getInstance(ollamaService, configService, context.workspaceState);
  const provider = new ChatViewProvider(context.extensionUri, ollamaService, outputChannel);

  outputChannel.appendLine(`[Extension] Ollama configured at: ${ollamaEndpoint}`);

  // Enforce state storage hygiene and gitignore protection across workspace folders
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const folder of folders) {
      WorkspaceManager.ensureStorageHygiene(folder).catch((err) => {
        outputChannel.appendLine(`[Extension] Warning: could not verify storage hygiene for ${folder.name}: ${err}`);
      });
      CodeGenerationEngine.recoverInterruptedTransaction(folder.uri).then((rec) => {
        if (rec.recovered) {
          outputChannel.appendLine(`[Extension] Recovered ${rec.filesRolledBack.length} file(s) from interrupted transaction.`);
        }
      }).catch(() => {});
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Watch for endpoint changes via ConfigurationService
  context.subscriptions.push(
    configService.onDidChangeEndpoint((newEndpoint) => {
      outputChannel.appendLine(`[Extension] Ollama endpoint updated to: ${newEndpoint}`);
      provider.handleEndpointChange(newEndpoint);
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
