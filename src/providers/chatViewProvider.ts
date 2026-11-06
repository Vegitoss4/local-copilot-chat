import * as vscode from 'vscode';
import { OllamaService, ChatMessage } from '../services/ollamaService';
import { WorkspaceContextService } from '../services/workspaceService';
import { AgentToolService, ToolCall, ToolResult } from '../services/agentToolService';
import { AppGeneratorService } from '../services/appGeneratorService';
import { AutonomousAgent, ApprovalRequest, ProgressEvent } from '../services/autonomousAgent';
import { SwarmOrchestrator } from '../services/swarmOrchestrator';
import { MemoryService } from '../services/memoryService';
import { ModelRouter } from '../services/modelRouter';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localCopilotChat.chatView';
  private _view?: vscode.WebviewView;
  private _currentAbortController?: AbortController;
  private _chatHistory: ChatMessage[] = [];
  private _cachedModels: string[] = [];
  private _pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  private _isAutonomousMode: boolean = true;
  private _currentAgent?: SwarmOrchestrator | AutonomousAgent;
  private _pendingUserAnswerResolver?: (answer: string) => void;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _ollamaService: OllamaService,
    private readonly _outputChannel?: vscode.OutputChannel
  ) {}

  private _log(msg: string) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console.log(line);
    this._outputChannel?.appendLine(line);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._log('[Webview] Resolving webview view provider...');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    this._log('[Webview] Webview HTML mounted.');

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'webviewLog': {
          this._log(`[Webview UI] [${data.level || 'info'}] ${data.message}`);
          if (data.level === 'error') {
            vscode.window.showErrorMessage(`Webview UI Error: ${data.message}`);
          }
          break;
        }
        case 'fetchModels': {
          this._log('[Webview] Requesting Ollama model list...');
          await this._handleFetchModels();
          break;
        }
        case 'sendMessage': {
          const mode: 'chat' | 'agent' = (data.mode === 'agent' || data.isAgent === true) ? 'agent' : 'chat';
          const rawModel = data.model || 'auto';
          const effectiveModel = (!rawModel || rawModel.toLowerCase() === 'auto')
            ? this.resolveAutoModel(data.text, mode)
            : rawModel;
          this._log(`[Webview] Received sendMessage: "${data.text}" | Mode: ${mode} | Model: ${effectiveModel}`);
          await this._handleSendMessage(data.text, effectiveModel, mode, data.autonomousMode);
          break;
        }
        case 'agentReply': {
          if (this._pendingUserAnswerResolver) {
            this._pendingUserAnswerResolver(data.text);
            this._pendingUserAnswerResolver = undefined;
          } else if (this._currentAgent) {
            this._currentAgent.resume(data.text);
          }
          break;
        }
        case 'toolApprovalResponse': {
          const resolver = this._pendingApprovals.get(data.id);
          if (resolver) {
            resolver(data.approved === true);
            this._pendingApprovals.delete(data.id);
          }
          break;
        }
        case 'stopGeneration': {
          if (this._currentAbortController) {
            this._currentAbortController.abort();
            this._currentAbortController = undefined;
          }
          if (this._pendingUserAnswerResolver) {
            this._pendingUserAnswerResolver('User cancelled request.');
            this._pendingUserAnswerResolver = undefined;
          }
          for (const [, resolver] of this._pendingApprovals.entries()) {
            resolver(false);
          }
          this._pendingApprovals.clear();
          this._currentAgent = undefined;
          break;
        }
        case 'getSelection': {
          const selection = this._getActiveEditorSelection();
          this._view?.webview.postMessage({
            type: 'activeSelection',
            selection: selection || '',
          });
          break;
        }
        case 'getActiveFile': {
          const fileCtx = await WorkspaceContextService.getActiveFileContext();
          this._view?.webview.postMessage({
            type: 'activeFile',
            file: fileCtx,
          });
          break;
        }
        case 'getWorkspaceContext': {
          const summary = await WorkspaceContextService.getWorkspaceSummary();
          this._view?.webview.postMessage({
            type: 'workspaceContext',
            context: summary,
          });
          break;
        }
        case 'insertCode': {
          await this._insertCodeAtCursor(data.code);
          break;
        }
        case 'createFile': {
          await this._createFileInWorkspace(data.fileName, data.code, false);
          break;
        }
        case 'runCommand': {
          this._runInTerminal(data.command);
          break;
        }
        case 'clearChat': {
          this._chatHistory = [];
          break;
        }
      }
    });
  }

  public sendCodePrompt(prefixPrompt: string) {
    const selection = this._getActiveEditorSelection();
    if (!selection) {
      vscode.window.showInformationMessage('Please select some code in the editor first.');
      return;
    }
    const fullPrompt = `${prefixPrompt}:\n\n\`\`\`\n${selection}\n\`\`\``;
    this._view?.show?.(true);
    this._view?.webview.postMessage({
      type: 'externalPrompt',
      prompt: fullPrompt,
    });
  }

  private _getActiveEditorSelection(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const selection = editor.selection;
    if (selection.isEmpty) return undefined;
    return editor.document.getText(selection);
  }

  private async _insertCodeAtCursor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found to insert code.');
      return;
    }
    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, code);
    });
    vscode.window.showInformationMessage('Code inserted into editor.');
  }

  private async _createFileInWorkspace(suggestedName: string, content: string, auto: boolean = false) {
    const folders = vscode.workspace.workspaceFolders;
    let fileName = suggestedName || 'index.html';

    if (!auto) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter the file name to create in your project:',
        value: fileName,
      });
      if (!input) return;
      fileName = input;
    }

    try {
      if (folders && folders.length > 0) {
        const fileUri = AgentToolService.getFileUri(fileName);
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`Created and opened "${fileName}"!`);
      } else {
        const doc = await vscode.workspace.openTextDocument({
          content,
          language: fileName.split('.').pop() || 'html',
        });
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`Opened "${fileName}". Use Ctrl+S to save.`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
    }
  }

  private _runInTerminal(command: string) {
    if (!command || !command.trim()) return;
    let terminal = vscode.window.terminals.find((t) => t.name === 'Local Copilot');
    if (!terminal) {
      terminal = vscode.window.createTerminal('Local Copilot');
    }
    terminal.show(true);
    terminal.sendText(command.trim());
    vscode.window.showInformationMessage(`Running in terminal: ${command.trim().slice(0, 50)}...`);
  }

  private async _handleFetchModels() {
    try {
      const models = await this._ollamaService.getAvailableModels();
      this._cachedModels = models;
      const config = vscode.workspace.getConfiguration('localCopilot');
      const defaultModel = config.get<string>('defaultModel') || (models[0] || 'qwen2.5-coder:7b');

      this._view?.webview.postMessage({
        type: 'modelsList',
        models,
        defaultModel,
      });

      // Update RAG Memory status in Webview
      try {
        const memory = MemoryService.getInstance(this._ollamaService);
        await memory.init();
        this._view?.webview.postMessage({
          type: 'memoryStatus',
          count: memory.getMemoryCount(),
        });
      } catch {}
    } catch (err: any) {
      this._view?.webview.postMessage({
        type: 'modelsError',
        error: err.message || 'Failed to load Ollama models.',
      });
    }
  }

  public resolveAutoModel(prompt: string, mode: string): string {
    // Agent mode starts with reasoning/orchestration
    if (mode === 'agent') {
      const deepseek = this._cachedModels.find(m => m.toLowerCase().includes('deepseek-r1')) || 'deepseek-r1:8b';
      return deepseek;
    }

    // Keywords that require deep reasoning
    const reasoningKeywords = /\b(why|explain|debug|diagnose|architecture|architect|plan|error|analyze|review|design|trace)\b/i;
    if (reasoningKeywords.test(prompt)) {
      const deepseek = this._cachedModels.find(m => m.toLowerCase().includes('deepseek-r1')) || 'deepseek-r1:8b';
      return deepseek;
    }

    // Default to fast syntax generation
    const qwen = this._cachedModels.find(m => m.toLowerCase().includes('qwen2.5-coder')) || 'qwen2.5-coder:7b';
    return qwen;
  }

  private async _handleSendMessage(
    userText: string,
    model: string,
    mode: 'chat' | 'agent' = 'chat',
    autonomousMode: boolean = true
  ) {
    if (!userText || !userText.trim()) return;

    this._isAutonomousMode = autonomousMode;
    this._currentAbortController = new AbortController();
    const signal = this._currentAbortController.signal;

    // Resolve Auto Model Selection
    const isAuto = (!model || model.toLowerCase() === 'auto');
    const resolvedModel = isAuto
      ? this.resolveAutoModel(userText, mode)
      : model;

    const trimmed = userText.trim();

    this._view?.webview.postMessage({
      type: 'startStream',
      userText,
      mode,
      model: isAuto ? `${resolvedModel} (Auto)` : resolvedModel,
    });

    // 1. Explicit Slash Command: /create-app (Autonomous Full-Stack Planner)
    if (trimmed.startsWith('/create-app')) {
      const appDescription = trimmed.replace(/^\/create-app/i, '').trim() || 'Task Manager App with .NET API and Angular';
      this._log(`[AppGenerator] Starting autonomous app generation: "${appDescription}" using model: ${resolvedModel}`);
      try {
        await AppGeneratorService.generateFullStackApp(
          appDescription,
          resolvedModel,
          this._ollamaService,
          (statusMsg: string) => {
            this._log(`[AppGenerator] ${statusMsg}`);
            this._view?.webview.postMessage({ type: 'streamChunk', chunk: '\n\n' + statusMsg });
          },
          signal
        );
        this._log(`[AppGenerator] Fullstack app generation complete!`);
        this._view?.webview.postMessage({ type: 'streamEnd' });
      } catch (err: any) {
        this._log(`[AppGenerator Error] ${err.message}`);
        if (err.name !== 'AbortError') {
          this._view?.webview.postMessage({ type: 'streamError', error: err.message });
        }
      } finally {
        this._currentAbortController = undefined;
      }
      return;
    }

    // 2. Explicit Slash Command: /diff
    if (trimmed.startsWith('/diff')) {
      const diff = await AgentToolService.getGitDiff();
      this._view?.webview.postMessage({
        type: 'streamChunk',
        chunk: `### 🌿 Workspace Git Diff\n\`\`\`diff\n${diff}\n\`\`\``
      });
      this._view?.webview.postMessage({ type: 'streamEnd' });
      this._currentAbortController = undefined;
      return;
    }

    // =========================================================================
    // BRANCH A: CHAT MODE (Conversational Q&A via streamChat)
    // =========================================================================
    if (mode === 'chat') {
      try {
        let enrichedPrompt = userText;
        const mentionsWorkspace = /\b(project|workspace|repo|repository|codebase|solution)\b/i.test(userText);
        if (userText.includes('@workspace') || mentionsWorkspace) {
          const workspaceSummary = await WorkspaceContextService.getWorkspaceSummary();
          enrichedPrompt = `${workspaceSummary}\n\nUser Question:\n${userText.replace('@workspace', '').trim()}`;
        }

        this._chatHistory.push({ role: 'user', content: enrichedPrompt });

        let assistantResponse = '';
        await this._ollamaService.streamChat(
          resolvedModel,
          this._chatHistory,
          (chunk) => {
            assistantResponse += chunk;
            this._view?.webview.postMessage({ type: 'streamChunk', chunk });
          },
          signal
        );

        this._chatHistory.push({ role: 'assistant', content: assistantResponse });
        this._view?.webview.postMessage({ type: 'streamEnd' });
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          this._view?.webview.postMessage({ type: 'streamError', error: err.message || 'Chat error.' });
        }
      } finally {
        this._currentAbortController = undefined;
      }
      return;
    }

    // =========================================================================
    // BRANCH B: AGENT MODE (Hierarchical Multi-Agent Swarm with VRAM Time-Slicing)
    // =========================================================================
    try {
      this._currentAgent = new SwarmOrchestrator(this._ollamaService, {
        maxTurns: 25,
        autonomousMode: this._isAutonomousMode,
        userModel: resolvedModel,
        availableModels: this._cachedModels.length > 0 ? this._cachedModels : [resolvedModel],
      });

      await this._currentAgent.runTask(
        userText,
        {
          onStatusUpdate: (status: string) => {
            this._view?.webview.postMessage({ type: 'agentStatus', status });
          },
          onProgress: (event: ProgressEvent) => {
            this._view?.webview.postMessage({ type: 'agentProgress', event });
          },
          onThought: (chunk: string) => {
            this._view?.webview.postMessage({ type: 'streamThought', chunk });
          },
          onText: (chunk: string) => {
            this._view?.webview.postMessage({ type: 'streamChunk', chunk });
          },
          onToolStart: (call: ToolCall) => {
            this._view?.webview.postMessage({ type: 'toolStart', call });
          },
          onToolEnd: (result: ToolResult) => {
            this._view?.webview.postMessage({ type: 'toolEnd', result });
          },
          requestApproval: (req: ApprovalRequest) => {
            return new Promise<boolean>((resolve) => {
              this._pendingApprovals.set(req.id, resolve);
              this._view?.webview.postMessage({
                type: 'requestApproval',
                request: req,
              });
            });
          },
          onAskUser: (question: string) => {
            return new Promise<string>((resolve) => {
              this._pendingUserAnswerResolver = resolve;
              this._view?.webview.postMessage({
                type: 'askUser',
                question,
              });
            });
          },
        },
        signal
      );

      this._view?.webview.postMessage({ type: 'streamEnd' });
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        this._view?.webview.postMessage({ type: 'streamAborted' });
      } else {
        this._view?.webview.postMessage({ type: 'streamError', error: err.message || 'Execution error.' });
      }
    } finally {
      this._currentAgent = undefined;
      this._pendingUserAnswerResolver = undefined;
      this._currentAbortController = undefined;
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local Copilot: Chat & Agent Mode</title>
  <style>
    :root {
      --chat-font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      --code-font: var(--vscode-editor-font-family, monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--chat-font);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header & Segmented Mode Control */
    .header {
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      background-color: var(--vscode-editor-background, #181818);
    }
    .header-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .mode-segmented-group, .mode-toggle-group, .segmented-control {
      display: inline-flex;
      background: var(--vscode-input-background, #1e1e1e);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 14px;
      padding: 2px;
      gap: 2px;
    }
    .mode-segment, .mode-btn, .segment-btn {
      border: none;
      background: transparent;
      color: var(--vscode-foreground, #cccccc);
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 12px;
      cursor: pointer;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease-in-out;
      outline: none;
    }
    .mode-segment *, .mode-btn *, .segment-btn * {
      pointer-events: none; /* Prevents clicks on child spans from hijacking target */
    }
    .mode-segment:hover, .mode-btn:hover {
      color: var(--vscode-foreground, #ffffff);
      background: rgba(255, 255, 255, 0.06);
    }
    .mode-segment.active, .mode-btn.active, .segment-btn.active {
      background: var(--vscode-button-background, #007acc) !important;
      color: var(--vscode-button-foreground, #ffffff) !important;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }
    .pill-btn, .toggle-pill {
      font-size: 10px;
      font-weight: bold;
      border-radius: 12px;
      padding: 2px 8px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid #4ec9b0;
      background: rgba(78, 201, 176, 0.15);
      color: #4ec9b0;
    }
    .pill-btn.inactive, .toggle-pill.inactive {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--vscode-panel-border, #444);
      color: var(--vscode-disabledForeground, #888);
    }
    .icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      font-size: 12px;
      opacity: 0.8;
    }
    .icon-btn:hover { background: rgba(255, 255, 255, 0.1); opacity: 1; }
    .model-row, .controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 4px;
    }
    .model-row label {
      font-size: 10px;
      font-weight: bold;
      opacity: 0.8;
    }
    .model-select, select#modelSelect {
      flex: 1;
      background: var(--vscode-dropdown-background, #252526);
      color: var(--vscode-dropdown-foreground, #f0f0f0);
      border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
      padding: 3px 6px;
      border-radius: 4px;
      font-size: 11px;
      outline: none;
      cursor: pointer;
    }
    .toggle-pill {
      font-size: 10px;
      font-weight: bold;
      border-radius: 12px;
      padding: 2px 8px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .toggle-pill.active {
      background: rgba(78, 201, 176, 0.15);
      border: 1px solid #4ec9b0;
      color: #4ec9b0;
    }
    .toggle-pill.inactive {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--vscode-panel-border, #444);
      color: var(--vscode-disabledForeground, #888);
    }
    .icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      font-size: 12px;
      opacity: 0.8;
    }
    .icon-btn:hover { background: rgba(255, 255, 255, 0.1); opacity: 1; }

    /* Messages Container */
    #messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 100%;
    }
    .message-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      opacity: 0.7;
      font-weight: 600;
      text-transform: uppercase;
    }
    .message-bubble {
      padding: 8px 12px;
      border-radius: 6px;
      line-height: 1.5;
    }
    .user .message-bubble {
      background: var(--vscode-editorHoverWidget-background, #2d2d2d);
      border: 1px solid var(--vscode-widget-border, #404040);
    }
    .assistant .message-bubble { background: transparent; padding: 4px 0; }

    /* ChatGPT-Style "Working..." Accordion */
    .working-accordion {
      margin: 6px 0;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-left: 3px solid #007acc;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11px;
    }
    .working-summary {
      cursor: pointer;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
      outline: none;
    }
    .working-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .working-spinner {
      display: inline-block;
      animation: spin 1.5s linear infinite;
    }
    @keyframes spin {
      100% { transform: rotate(360deg); }
    }
    .working-step-count {
      font-size: 10px;
      opacity: 0.6;
      font-weight: normal;
    }
    .working-timeline {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 6px;
      max-height: 180px;
      overflow-y: auto;
    }
    .timeline-step {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 11px;
      font-family: var(--code-font);
      opacity: 0.9;
    }
    .timeline-step .step-icon { flex-shrink: 0; }
    .timeline-step .step-text { word-break: break-all; }

    /* Hierarchical Swarm Agent Persona Badges */
    .agent-tag {
      display: inline-flex;
      align-items: center;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 4px;
      letter-spacing: 0.3px;
      flex-shrink: 0;
      line-height: 1.4;
    }
    .agent-tag.orchestrator {
      background: rgba(168, 85, 247, 0.2);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.35);
    }
    .agent-tag.planner {
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.35);
    }
    .agent-tag.coder {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }
    .agent-tag.tester {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.35);
    }

    /* RAG Long-Term Memory Indicator */
    .memory-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.12);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 2px 7px;
      border-radius: 10px;
      cursor: default;
      user-select: none;
    }

    /* DeepSeek Think Block */
    .think-box {
      margin: 4px 0;
      padding: 6px;
      background: rgba(179, 136, 255, 0.05);
      border-left: 2px solid #b388ff;
      border-radius: 4px;
      font-size: 11px;
    }
    .think-box summary {
      cursor: pointer;
      font-weight: 600;
      color: #b388ff;
      user-select: none;
    }
    .think-content {
      margin-top: 4px;
      opacity: 0.85;
      font-style: italic;
      white-space: pre-wrap;
    }

    /* Tool Result Chips */
    .tool-chip {
      margin: 3px 0;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-family: var(--code-font);
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .tool-chip.succeeded { border-left: 2px solid #4ec9b0; }
    .tool-chip.failed { border-left: 2px solid #f14c4c; }

    /* "Pause & Ask" Clarification Card */
    .agent-ask-box {
      margin: 10px 0;
      padding: 12px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid #3794ff;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ask-header {
      font-weight: bold;
      color: #3794ff;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ask-question {
      font-size: 12px;
      line-height: 1.4;
      color: #fff;
    }
    .ask-input-row {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }
    .ask-input {
      flex: 1;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #fff);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      outline: none;
    }
    .ask-input:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .btn-ask-reply {
      background: var(--vscode-button-background, #007acc);
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .btn-ask-reply:hover { background: var(--vscode-button-hoverBackground, #0062a3); }

    /* Approval Card */
    .approval-card {
      margin: 8px 0;
      padding: 10px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid #ffb74d;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .approval-header {
      font-weight: bold;
      color: #ffb74d;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .approval-desc {
      font-size: 11px;
      margin-bottom: 8px;
      font-family: var(--code-font);
    }
    .approval-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .btn-approve {
      background: var(--vscode-button-background, #007acc);
      color: #fff;
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .btn-deny {
      background: transparent;
      border: 1px solid var(--vscode-panel-border, #555);
      color: var(--vscode-foreground);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }

    /* Code Blocks */
    pre {
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #333);
      border-radius: 6px;
      margin: 6px 0;
      overflow-x: auto;
      font-family: var(--code-font);
      font-size: 11px;
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 10px;
      color: var(--vscode-descriptionForeground, #999);
    }
    .code-actions button {
      background: transparent;
      border: 1px solid var(--vscode-button-secondaryBorder, #444);
      color: var(--vscode-button-secondaryForeground, #ccc);
      padding: 2px 6px;
      font-size: 10px;
      border-radius: 3px;
      cursor: pointer;
      margin-left: 4px;
    }
    .code-actions button:hover { background: var(--vscode-button-hoverBackground, #007acc); color: #fff; }
    pre code { display: block; padding: 6px 8px; white-space: pre-wrap; font-family: var(--code-font); }
    p code { background: rgba(255, 255, 255, 0.1); padding: 1px 4px; border-radius: 3px; font-family: var(--code-font); font-size: 0.9em; }

    /* Footer */
    .footer {
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border, #333);
      background: var(--vscode-editor-background, #181818);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .context-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .context-btn {
      background: transparent;
      border: 1px dashed var(--vscode-panel-border, #555);
      color: var(--vscode-foreground);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 10px;
      cursor: pointer;
      opacity: 0.85;
    }
    .context-btn:hover { border-color: var(--vscode-button-background, #007acc); opacity: 1; }
    .textarea-wrapper {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #252526);
      border-radius: 6px;
      padding: 6px;
    }
    .textarea-wrapper:focus-within { border-color: var(--vscode-focusBorder, #007acc); }
    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 160px;
      background: transparent;
      color: var(--vscode-input-foreground, #fff);
      border: none;
      outline: none;
      resize: none;
      font-family: var(--chat-font);
      font-size: 12px;
      line-height: 1.4;
    }
    .input-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 4px;
    }
    .btn-send {
      background: var(--vscode-button-background, #007acc);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 600;
    }
    .btn-stop {
      background: var(--vscode-errorForeground, #f14c4c);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      display: none;
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--vscode-descriptionForeground, #888);
      gap: 6px;
      padding: 16px;
    }
  </style>
</head>
<body>
  <!-- Top Header with Segmented Mode Control -->
  <div class="header">
    <div class="header-controls">
      <!-- Segmented Mode Control -->
      <div class="mode-segmented-group" role="tablist">
        <button type="button" id="tab-mode-chat" class="mode-segment active" data-mode="chat" onclick="setMode('chat')">
          💬 Chat
        </button>
        <button type="button" id="tab-mode-agent" class="mode-segment" data-mode="agent" onclick="setMode('agent')">
          ⚡ Agent
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <button type="button" id="auto-btn" class="pill-btn active" onclick="toggleAuto()">⚡ Auto: ON</button>
        <button type="button" id="reset-btn" class="icon-btn" onclick="fetchModels()" title="Reset Session">🔄</button>
        <button type="button" id="clear-btn" class="icon-btn" onclick="clearConversation()" title="Clear Chat">🗑️</button>
      </div>
    </div>

    <div class="model-row">
      <div style="display: flex; align-items: center; gap: 6px; flex: 1;">
        <label for="modelSelect">MODEL:</label>
        <select id="modelSelect">
          <option value="auto" selected>✨ Auto (Smart Route)</option>
          <option value="deepseek-r1:8b">deepseek-r1:8b</option>
          <option value="qwen2.5-coder:7b">qwen2.5-coder:7b</option>
          <option value="qwen3.5:9b">qwen3.5:9b</option>
        </select>
      </div>
      <span class="memory-badge" id="memoryBadge">💾 Memory: Active</span>
    </div>
  </div>

  <!-- Messages -->
  <div id="messages-container">
    <div class="empty-state" id="empty-state">
      <div style="font-size: 26px;">🤖</div>
      <div style="font-weight: 600; font-size: 14px;" id="empty-title">Local Copilot (Chat Mode)</div>
      <div style="font-size: 11px; opacity: 0.7;" id="empty-subtitle">Ask questions, explain code, or generate snippets</div>
      <div style="font-size: 11px; line-height: 1.6; margin-top: 6px; text-align: left; background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px;" id="empty-tips">
        <div><b>💬 Chat Mode</b>: Conversational assistance, refactoring &amp; explanations</div>
        <div><b>⚡ Agent Mode</b>: Autonomous multi-turn tools, surgical file edits &amp; self-healing</div>
        <div><b>/create-app &lt;idea&gt;</b>: Full-stack .NET &amp; Angular App Generator</div>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="context-bar">
      <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        <button type="button" id="create-app-btn" class="context-btn" onclick="triggerCreateApp()" title="Autonomous App Generator" style="color: #ffb74d; border-color: #ffb74d; font-weight: bold;">
          🚀 Create App
        </button>
        <button type="button" id="add-selection-btn" class="context-btn" onclick="triggerSelection()" title="Attach selection">📌 Selection</button>
        <button type="button" id="add-active-file-btn" class="context-btn" onclick="triggerActiveFile()" title="Attach active open file">📄 Active</button>
        <button type="button" id="add-workspace-btn" class="context-btn" onclick="triggerWorkspace()" title="Attach project structure">📁 Project</button>
        <button type="button" id="build-btn" class="context-btn" onclick="triggerBuild()" title="Run build and fix errors">🔨 Build &amp; Fix</button>
        <button type="button" id="diff-btn" class="context-btn" onclick="triggerDiff()" title="Git diff">🌿 Diff</button>
      </div>
      <span id="chat-mode-label" style="font-size: 9px; opacity: 0.6;">💬 Chat Mode</span>
    </div>
    <div class="textarea-wrapper">
      <textarea id="chatInput" data-id="prompt-input" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitUserMessage();}" placeholder="Ask anything about your code... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-actions">
        <button type="button" id="stop-btn" class="btn-stop" onclick="stopGeneration()">Stop</button>
        <button type="button" id="sendButton" class="btn-send" onclick="submitUserMessage()">Send</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: "webviewLog", level: "info", message: "Webview script loaded and running" });
    const messagesContainer = document.getElementById('messages-container');
    const emptyState = document.getElementById('empty-state');
    const chatInput = document.getElementById('chatInput');
    const promptInput = chatInput;

    let activeMode = 'chat'; // Single source of truth: 'chat' | 'agent'
    let currentMode = 'chat';
    let isAutonomous = true;
    let isStreaming = false;
    let isWaitingForAgentReply = false;

    // Active Generation Containers
    let currentAssistantBubble = null;
    let currentWorkingAccordion = null;
    let currentWorkingTimeline = null;
    let currentWorkingTitle = null;
    let currentWorkingSpinner = null;
    let currentWorkingCount = null;
    let currentRawMarkdown = '';
    let currentRawThought = '';
    let currentThinkContainer = null;
    let stepCount = 0;

    window.onerror = function(msg, url, line, col, err) {
      try {
        vscode.postMessage({ type: 'webviewLog', level: 'error', message: String(msg) + ' (' + line + ':' + col + ')' });
      } catch (e) {}
    };

    function setMode(targetMode) {
      if (targetMode !== 'chat' && targetMode !== 'agent') return;
      activeMode = targetMode;
      currentMode = targetMode;
      const isAgent = (activeMode === 'agent');

      const chatTab = document.getElementById('tab-mode-chat');
      const agentTab = document.getElementById('tab-mode-agent');
      if (chatTab && agentTab) {
        if (isAgent) {
          chatTab.classList.remove('active');
          agentTab.classList.add('active');
          chatTab.setAttribute('aria-pressed', 'false');
          agentTab.setAttribute('aria-pressed', 'true');
        } else {
          chatTab.classList.add('active');
          agentTab.classList.remove('active');
          chatTab.setAttribute('aria-pressed', 'true');
          agentTab.setAttribute('aria-pressed', 'false');
        }
      }

      const modeIndicator = document.getElementById('chat-mode-label') || document.getElementById('footer-mode-hint');
      if (modeIndicator) {
        modeIndicator.innerText = isAgent ? '⚡ Agent Mode' : '💬 Chat Mode';
      }

      const sBtn = document.getElementById('sendButton') || document.getElementById('send-btn');
      if (sBtn) {
        sBtn.innerText = isAgent ? 'Run Agent' : 'Send';
      }

      const inp = document.getElementById('chatInput');
      if (inp) {
        inp.placeholder = isAgent 
          ? 'Assign an autonomous goal or bug fix... (Enter to run, Shift+Enter for newline)'
          : 'Ask anything about your code... (Enter to send, Shift+Enter for newline)';
      }

      const eTitle = document.getElementById('empty-title');
      if (eTitle) {
        eTitle.innerText = isAgent ? 'Local Copilot (Agent Mode)' : 'Local Copilot (Chat Mode)';
      }
      const eSubtitle = document.getElementById('empty-subtitle');
      if (eSubtitle) {
        eSubtitle.innerText = isAgent 
          ? 'Autonomous ReAct loop with surgical str_replace & self-healing'
          : 'Standard conversational assistance, explanations & code generation';
      }
    }
    window.setMode = setMode;
    window.updateMode = setMode;

    function submitUserMessage() {
      try {
        const inputEl = document.getElementById('chatInput');
        const text = inputEl ? inputEl.value.trim() : '';
        if (!text) {
          vscode.postMessage({ type: 'webviewLog', level: 'info', message: 'Send triggered with empty input' });
          return;
        }

        vscode.postMessage({ type: 'webviewLog', level: 'info', message: 'User submitting: ' + text.substring(0, 50) });

        if (isWaitingForAgentReply) {
          submitAgentReplyText(text);
          if (inputEl) inputEl.value = '';
          return;
        }

        if (isStreaming) {
          vscode.postMessage({ type: 'webviewLog', level: 'warn', message: 'Submit ignored: streaming is active' });
          return;
        }

        const modelSelect = document.getElementById('modelSelect');
        const selectedModel = modelSelect ? modelSelect.value : 'auto';

        if (inputEl) {
          inputEl.value = '';
          if (inputEl.style) inputEl.style.height = 'auto';
        }

        setStreamingState(true);

        vscode.postMessage({
          type: 'sendMessage',
          text: text,
          mode: activeMode,
          model: selectedModel,
          autonomousMode: isAutonomous
        });
      } catch (err) {
        vscode.postMessage({ type: 'webviewLog', level: 'error', message: 'submitUserMessage error: ' + String(err) });
      }
    }
    window.submitUserMessage = submitUserMessage;
    window.sendMessage = submitUserMessage;
    window.handleSend = submitUserMessage;

    function toggleAuto() {
      isAutonomous = !isAutonomous;
      const autoBtn = document.getElementById('auto-btn') || document.getElementById('autonomous-toggle');
      if (autoBtn) {
        autoBtn.className = isAutonomous ? 'pill-btn active' : 'pill-btn inactive';
        autoBtn.textContent = isAutonomous ? '⚡ Auto: ON' : '🛡️ Auto: OFF';
      }
    }
    window.toggleAuto = toggleAuto;

    function fetchModels() {
      vscode.postMessage({ type: 'fetchModels' });
    }
    window.fetchModels = fetchModels;

    function clearConversation() {
      const container = document.getElementById('messages-container');
      const emptyEl = document.getElementById('empty-state');
      if (container && emptyEl) {
        container.innerHTML = '';
        container.appendChild(emptyEl);
        emptyEl.style.display = 'flex';
      }
      vscode.postMessage({ type: 'clearChat' });
    }
    window.clearConversation = clearConversation;

    function stopGeneration() {
      vscode.postMessage({ type: 'stopGeneration' });
    }
    window.stopGeneration = stopGeneration;

    function triggerCreateApp() {
      const inp = document.getElementById('chatInput');
      if (inp) {
        inp.value = '/create-app Task Manager fullstack app with .NET API and Angular';
        inp.focus();
      }
    }
    window.triggerCreateApp = triggerCreateApp;

    function triggerBuild() {
      const inp = document.getElementById('chatInput');
      if (inp) {
        inp.value = '/build';
        submitUserMessage();
      }
    }
    window.triggerBuild = triggerBuild;

    function triggerDiff() {
      const inp = document.getElementById('chatInput');
      if (inp) {
        inp.value = '/diff';
        submitUserMessage();
      }
    }
    window.triggerDiff = triggerDiff;

    function triggerSelection() {
      vscode.postMessage({ type: 'getSelection' });
    }
    window.triggerSelection = triggerSelection;

    function triggerActiveFile() {
      vscode.postMessage({ type: 'getActiveFile' });
    }
    window.triggerActiveFile = triggerActiveFile;

    function triggerWorkspace() {
      const inp = document.getElementById('chatInput');
      if (inp) {
        inp.value = (inp.value ? inp.value + ' ' : '') + '@workspace';
        inp.focus();
      }
    }
    window.triggerWorkspace = triggerWorkspace;

    // Attach explicit click handlers to mode segment tabs
    const tabChat = document.getElementById('tab-mode-chat');
    const tabAgent = document.getElementById('tab-mode-agent');
    if (tabChat) {
      tabChat.onclick = function(e) { if (e) e.preventDefault(); setMode('chat'); };
    }
    if (tabAgent) {
      tabAgent.onclick = function(e) { if (e) e.preventDefault(); setMode('agent'); };
    }

    // Attach click and enter handlers
    const sendButtonEl = document.getElementById('sendButton') || document.getElementById('send-btn');
    if (sendButtonEl) {
      sendButtonEl.onclick = function(e) { if (e) e.preventDefault(); submitUserMessage(); };
    }

    const chatInputEl = document.getElementById('chatInput');
    if (chatInputEl) {
      chatInputEl.onkeydown = function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitUserMessage();
        }
      };
    }

    vscode.postMessage({ type: 'fetchModels' });

    function submitAgentReplyText(replyText) {
      isWaitingForAgentReply = false;
      const askBox = document.querySelector('.agent-ask-box.active');
      if (askBox) {
        askBox.className = 'agent-ask-box';
        askBox.innerHTML = '<div style="font-size:11px; color:#4ec9b0; font-weight:bold;">✅ You replied: "' + escapeHtml(replyText) + '"</div>';
      }
      setMode(currentMode); // Reset prompt placeholder
      vscode.postMessage({ type: 'agentReply', text: replyText });
    }

    window.submitInlineReply = function(btn) {
      const input = btn.previousElementSibling;
      const val = input ? input.value.trim() : '';
      if (val) submitAgentReplyText(val);
    };

    window.respondApproval = function(id, approved) {
      const card = document.getElementById('approval-' + id);
      if (card) {
        card.innerHTML = '<div style="font-size:11px; color:' + (approved ? '#4ec9b0' : '#f14c4c') + ';">' + (approved ? '✅ Action Approved' : '❌ Action Denied') + '</div>';
      }
      vscode.postMessage({ type: 'toolApprovalResponse', id: id, approved: approved });
    };

    function setStreamingState(streaming) {
      isStreaming = streaming;
      const sBtn = document.getElementById('sendButton') || document.getElementById('send-btn');
      const stBtn = document.getElementById('stop-btn');
      const mSel = document.getElementById('modelSelect');
      const rBtn = document.getElementById('reset-btn') || document.getElementById('refresh-models-btn');
      if (sBtn) sBtn.style.display = streaming ? 'none' : 'block';
      if (stBtn) stBtn.style.display = streaming ? 'block' : 'none';
      if (mSel) mSel.disabled = streaming;
      if (rBtn) rBtn.disabled = streaming;
    }

    // Message handler from Extension Host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      const container = document.getElementById('messages-container');
      const emptyEl = document.getElementById('empty-state');

      switch (msg.type) {
        case 'modelsList': {
          const modelSelect = document.getElementById('modelSelect');
          if (modelSelect) {
            modelSelect.innerHTML = '<option value="auto" selected>✨ Auto (Smart Route)</option>';
            msg.models.forEach((model) => {
              const opt = document.createElement('option');
              opt.value = model;
              opt.textContent = model;
              modelSelect.appendChild(opt);
            });
          }
          break;
        }

        case 'memoryStatus': {
          const badge = document.getElementById('memoryBadge') || document.getElementById('memory-count-label');
          if (badge) {
            badge.textContent = msg.count > 0 ? ('💾 Memory: ' + msg.count + ' items') : '💾 Memory: Active';
          }
          break;
        }

        case 'activeSelection': {
          if (msg.selection) {
            const inp = document.getElementById('chatInput');
            if (inp) {
              var LF = String.fromCharCode(10); var FENCE = String.fromCharCode(96,96,96); inp.value += LF + FENCE + LF + msg.selection + LF + FENCE + LF;
              inp.focus();
            }
          }
          break;
        }

        case 'activeFile': {
          if (msg.file) {
            const inp = document.getElementById('chatInput');
            if (inp) {
              var LF = String.fromCharCode(10); var FENCE = String.fromCharCode(96,96,96); inp.value += LF + "// File: " + msg.file.path + LF + FENCE + LF + msg.file.content + LF + FENCE + LF;
              inp.focus();
            }
          }
          break;
        }

        case 'startStream': {
          if (emptyEl) emptyEl.style.display = 'none';
          appendUserMessage(msg.userText);
          const assistant = createAssistantMessage(msg.mode || activeMode, msg.model);
          currentAssistantBubble = assistant.bubble;
          currentWorkingAccordion = assistant.workingAccordion;
          currentWorkingTimeline = assistant.workingTimeline;
          currentWorkingTitle = assistant.workingTitle;
          currentWorkingSpinner = assistant.workingSpinner;
          currentWorkingCount = assistant.workingCount;
          currentThinkContainer = assistant.thinkContainer;
          currentRawMarkdown = '';
          currentRawThought = '';
          stepCount = 0;
          setStreamingState(true);
          break;
        }

        case 'agentProgress': {
          stepCount++;
          if (currentWorkingCount) currentWorkingCount.textContent = stepCount + ' step' + (stepCount > 1 ? 's' : '');
          if (currentWorkingTitle) {
            const rolePrefix = msg.event.agentName ? '[' + msg.event.agentName + '] ' : '';
            currentWorkingTitle.textContent = rolePrefix + msg.event.message;
          }
          appendTimelineStep(msg.event.icon, msg.event.message, msg.event);
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'agentStatus': {
          if (currentWorkingTitle) currentWorkingTitle.textContent = msg.status;
          break;
        }

        case 'streamThought': {
          currentRawThought += msg.chunk;
          renderThought(currentThinkContainer, currentRawThought);
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'streamChunk': {
          currentRawMarkdown += msg.chunk;
          renderMarkdown(currentAssistantBubble, currentRawMarkdown);
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'toolStart': {
          appendTimelineStep('⚙️', 'Invoking ' + msg.call.function.name + '...');
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'toolEnd': {
          appendToolResultChip(msg.result);
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'askUser': {
          isWaitingForAgentReply = true;
          renderAskUserCard(msg.question);
          const inp = document.getElementById('chatInput');
          if (inp) {
            inp.placeholder = 'Agent is waiting for your reply above... (or type here and press Enter)';
            inp.focus();
          }
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'requestApproval': {
          appendApprovalCard(msg.request);
          if (container) container.scrollTop = container.scrollHeight;
          break;
        }

        case 'streamEnd':
        case 'streamAborted': {
          setStreamingState(false);
          if (currentWorkingAccordion) {
            if (currentWorkingSpinner) {
              currentWorkingSpinner.textContent = '✅';
              currentWorkingSpinner.style.animation = 'none';
            }
            if (currentWorkingTitle) {
              currentWorkingTitle.textContent = 'Working Process (' + stepCount + ' steps)';
            }
          }
          currentAssistantBubble = null;
          break;
        }

        case 'streamError': {
          setStreamingState(false);
          if (currentAssistantBubble) {
            currentAssistantBubble.innerHTML += '<div style="color:var(--vscode-errorForeground); margin-top:8px;">⚠️ ' + escapeHtml(msg.error) + '</div>';
          }
          break;
        }
      }
    });

    function appendUserMessage(text) {
      const container = document.getElementById('messages-container');
      if (!container) return;
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message user';
      const cleanText = escapeHtml(text).split(String.fromCharCode(10)).join('<br>');
      msgDiv.innerHTML = '<div class="message-header"><span>You</span></div>' +
        '<div class="message-bubble">' + cleanText + '</div>';
      container.appendChild(msgDiv);
      container.scrollTop = container.scrollHeight;
    }

    function createAssistantMessage(mode, modelName) {
      const container = document.getElementById('messages-container');
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      const mSel = document.getElementById('modelSelect');
      const selectedModel = modelName || (mSel ? mSel.value : 'Local Copilot');
      const badge = mode === 'agent' ? ' (⚡ Agent Mode)' : ' (💬 Chat Mode)';

      let accordionHtml = '';
      if (mode === 'agent') {
        accordionHtml = '<details open class="working-accordion">' +
          '<summary class="working-summary">' +
            '<div class="working-title-group">' +
              '<span class="working-spinner">🔄</span>' +
              '<span class="working-title">Working...</span>' +
            '</div>' +
            '<span class="working-step-count">0 steps</span>' +
          '</summary>' +
          '<div class="working-timeline"></div>' +
        '</details>';
      }

      msgDiv.innerHTML = '<div class="message-header"><span>' + escapeHtml(selectedModel) + badge + '</span></div>' +
        accordionHtml +
        '<details class="think-box" style="display:none;"><summary>💭 Thought process</summary><div class="think-content"></div></details>' +
        '<div class="agent-ask-container"></div>' +
        '<div class="message-bubble">...</div>';

      if (container) {
        container.appendChild(msgDiv);
        container.scrollTop = container.scrollHeight;
      }

      return {
        workingAccordion: msgDiv.querySelector('.working-accordion'),
        workingTimeline: msgDiv.querySelector('.working-timeline'),
        workingTitle: msgDiv.querySelector('.working-title'),
        workingSpinner: msgDiv.querySelector('.working-spinner'),
        workingCount: msgDiv.querySelector('.working-step-count'),
        thinkContainer: msgDiv.querySelector('.think-box'),
        bubble: msgDiv.querySelector('.message-bubble')
      };
    }

    function appendTimelineStep(icon, text, event) {
      if (!currentWorkingTimeline) return;
      const step = document.createElement('div');
      step.className = 'timeline-step';
      let tagHtml = '';
      if (event && event.agentRole) {
        const role = escapeHtml(event.agentRole.toLowerCase());
        const name = escapeHtml(event.agentName || role);
        tagHtml = '<span class="agent-tag ' + role + '">' + name + '</span>';
      }
      step.innerHTML = '<span class="step-icon">' + icon + '</span>' + tagHtml + '<span class="step-text">' + escapeHtml(text) + '</span>';
      currentWorkingTimeline.appendChild(step);
      currentWorkingTimeline.scrollTop = currentWorkingTimeline.scrollHeight;
    }

    function appendToolResultChip(res) {
      if (!currentWorkingTimeline || !res) return;
      const chip = document.createElement('div');
      chip.className = 'tool-chip ' + (res.success ? 'succeeded' : 'failed');
      const out = res.output || '';
      chip.textContent = (res.success ? '✅ ' : '❌ ') + (res.name || 'tool') + ': ' + out.slice(0, 80) + (out.length > 80 ? '...' : '');
      currentWorkingTimeline.appendChild(chip);
      currentWorkingTimeline.scrollTop = currentWorkingTimeline.scrollHeight;
    }

    function renderThought(container, rawText) {
      if (!container || !rawText) return;
      if (container.style) container.style.display = 'block';
      const content = (typeof container.querySelector === 'function') ? container.querySelector('.think-content') : null;
      if (content) {
        content.textContent = rawText.replaceAll('<think>', '').replaceAll('</think>', '').trim();
      }
    }

    function renderAskUserCard(question) {
      const container = document.getElementById('messages-container');
      const askContainer = container ? container.querySelector('.message.assistant:last-child .agent-ask-container') : null;
      if (!askContainer) return;

      const card = document.createElement('div');
      card.className = 'agent-ask-box active';
      card.innerHTML = '<div class="ask-header">🙋 Clarification Required</div>' +
        '<div class="ask-question">' + escapeHtml(question) + '</div>' +
        '<div class="ask-input-row">' +
          '<input type="text" class="ask-input" placeholder="Type your answer here..." onkeydown="if(event.key===&quot;Enter&quot;) submitInlineReply(this.nextElementSibling);" />' +
          '<button class="btn-ask-reply" onclick="submitInlineReply(this)">Reply</button>' +
        '</div>';
      askContainer.appendChild(card);
      const input = card.querySelector('.ask-input');
      if (input) input.focus();
    }

    function appendApprovalCard(req) {
      const container = document.getElementById('messages-container');
      if (!container) return;
      const msgDiv = document.createElement('div');
      msgDiv.className = 'approval-card';
      msgDiv.id = 'approval-' + req.id;
      msgDiv.innerHTML = '<div class="approval-header">⚠️ Confirmation Required: ' + escapeHtml(req.toolName) + '</div>' +
        '<div class="approval-desc">' + escapeHtml(req.description) + '</div>' +
        '<div class="approval-actions">' +
          '<button class="btn-approve" onclick="respondApproval(&quot;' + req.id + '&quot;, true)">Approve</button>' +
          '<button class="btn-deny" onclick="respondApproval(&quot;' + req.id + '&quot;, false)">Deny</button>' +
        '</div>';
      container.appendChild(msgDiv);
      container.scrollTop = container.scrollHeight;
    }

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderMarkdown(element, rawText) {
          if (!element) return;
          var FENCE = String.fromCharCode(96, 96, 96);
          var BT = String.fromCharCode(96);
          var LF = String.fromCharCode(10);
          var fencePattern = new RegExp("(" + FENCE + "[\\s\\S]*?" + FENCE + ")", "g");
          var parts = rawText.split(fencePattern);
          var html = "";
    
          for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (!part) continue;
            if (part.startsWith(FENCE) && part.endsWith(FENCE) && part.length >= 6) {
              var firstLineBreak = part.indexOf(LF);
              var lang = "code";
              var codeContent = "";
              if (firstLineBreak !== -1) {
                lang = part.substring(3, firstLineBreak).trim() || "code";
                codeContent = part.substring(firstLineBreak + 1, part.length - 3);
              } else {
                codeContent = part.substring(3, part.length - 3);
              }
    
              var escaped = escapeHtml(codeContent);
              var encoded = encodeURIComponent(codeContent);
              var isShell = /^(bash|sh|powershell|pwsh|cmd|shell|terminal|zsh)$/i.test(lang);
    
              var actionButtons = '<button onclick="copyCode(&quot;' + encoded + '&quot;)">Copy</button>';
                    if (isShell) {
                      actionButtons += '<button onclick="runCommand(&quot;' + encoded + '&quot;)" style="color:#4ec9b0; font-weight:bold;">▶️ Run</button>';
                    } else {
                      actionButtons += '<button onclick="insertCode(&quot;' + encoded + '&quot;)">Insert</button>' +
                        '<button onclick="createFile(&quot;' + encoded + '&quot;, &quot;' + escapeHtml(lang) + '&quot;)">📄 Create File</button>';
                    }
          
                    html += '<pre><div class="code-header"><span>' + escapeHtml(lang) + '</span><div class="code-actions">' + actionButtons + '</div></div><code>' + escaped + '</code></pre>';
                  } else {
                    var formatted = escapeHtml(part);
                    var segments = formatted.split(BT);
                    var inlineHtml = '';
                    for (var j = 0; j < segments.length; j++) {
                      inlineHtml += (j % 2 === 1) ? ('<code>' + segments[j] + '</code>') : segments[j];
                    }
                    html += inlineHtml.split(LF).join('<br>');
                  }
                }
      element.innerHTML = html;
        }

    window.copyCode = function(encoded) {
      navigator.clipboard.writeText(decodeURIComponent(encoded));
    };

    window.insertCode = function(encoded) {
      vscode.postMessage({ type: 'insertCode', code: decodeURIComponent(encoded) });
    };

    window.createFile = function(encoded, lang) {
      const code = decodeURIComponent(encoded);
      let ext = 'txt';
      const cleanLang = (lang || '').toLowerCase();
      if (cleanLang.includes('html')) ext = 'html';
      else if (cleanLang.includes('javascript') || cleanLang.includes('js')) ext = 'js';
      else if (cleanLang.includes('typescript') || cleanLang.includes('ts')) ext = 'ts';
      else if (cleanLang.includes('python') || cleanLang.includes('py')) ext = 'py';
      else if (cleanLang.includes('csharp') || cleanLang.includes('cs')) ext = 'cs';
      else if (cleanLang.includes('json')) ext = 'json';
      else if (cleanLang.includes('css')) ext = 'css';

      vscode.postMessage({ type: 'createFile', fileName: ext === 'html' ? 'index.html' : ('file.' + ext), code: code });
    };

    window.runCommand = function(encoded) {
      vscode.postMessage({ type: 'runCommand', command: decodeURIComponent(encoded) });
    };
  </script>
</body>
</html>`;
  }
}
