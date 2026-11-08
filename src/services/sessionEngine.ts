import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { OllamaService, ChatMessage, OllamaTimeoutError, OllamaTimeoutOptions } from './ollamaService';
import { WorkspaceContextService } from './workspaceService';
import { AgentToolService, ToolCall, ToolResult } from './agentToolService';
import { AppGeneratorService } from './appGeneratorService';
import { AutonomousAgent, ApprovalRequest, ProgressEvent } from './autonomousAgent';
import { SwarmOrchestrator } from './swarmOrchestrator';
import { ConfigurationService } from './configurationService';
import { AtomicFileWriter } from './atomicFileWriter';
import { ModelLifecycleManager } from './modelLifecycleManager';
import { CalibrationWizard } from './calibrationWizard';
import { ExtensionLogger } from './extensionLogger';
import { WorkspaceManager } from './workspaceManager';
import { AutonomousDebuggerService } from './autonomousDebuggerService';
import { EvaluationService } from './evaluationService';
import { PathSecurity } from './pathSecurity';
import { ModelRouter } from './modelRouter';

/**
 * Deliverable 11.0: SessionEngine Extraction
 * Decoupled, headless session and orchestration engine that manages turns,
 * streaming, tool calls, single-flight concurrency, and approval lifecycles
 * independently of UI presentations (Webview or Terminal).
 */

export type SessionMode = 'chat' | 'agent' | 'plan';

export interface SessionEngineEvents {
  onStartStream?: (payload: { userText: string; mode: SessionMode; model: string }) => void;
  onToken?: (chunk: string) => void;
  onThought?: (chunk: string) => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (result: ToolResult) => void;
  onAgentStatus?: (status: string) => void;
  onAgentProgress?: (event: ProgressEvent) => void;
  onRequestApproval?: (request: ApprovalRequest) => Promise<boolean> | void;
  onAskUser?: (question: string) => Promise<string> | void;
  onStreamEnd?: (payload: { response: string; cleanResponse: string; durationMs: number }) => void;
  onStreamError?: (error: string) => void;
  onHistoryUpdated?: (history: ChatMessage[]) => void;
}

export interface SendMessageOptions {
  model?: string;
  mode?: SessionMode;
  autonomousMode?: boolean;
}

export class GenerationActiveError extends Error {
  constructor(message: string = 'A generation is already in progress. Please wait for it to complete or click Stop before sending a new message.') {
    super(message);
    this.name = 'GenerationActiveError';
  }
}

export class SessionEngine {
  private static _instance: SessionEngine | undefined;

  private _sessionId: string;
  private _ollamaService: OllamaService;
  private _mode: SessionMode = 'chat';
  private _model: string = 'qwen2.5-coder:7b';
  private _isAutonomousMode: boolean = true;
  private _isGenerating: boolean = false;
  private _generationCounter: number = 0;
  private _currentGenerationId: number = 0;
  private _currentAbortController?: AbortController;
  private _chatHistory: ChatMessage[] = [];
  private _pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  private _pendingUserAnswerResolver?: (answer: string) => void;
  private _currentAgent?: SwarmOrchestrator | AutonomousAgent;
  private _cachedModels: string[] = [];
  private _events: SessionEngineEvents = {};
  private _outputChannel?: vscode.OutputChannel;

  constructor(
    ollamaService: OllamaService,
    outputChannel?: vscode.OutputChannel,
    initialSessionId?: string
  ) {
    this._ollamaService = ollamaService;
    this._outputChannel = outputChannel;
    this._sessionId = initialSessionId || `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  public static getInstance(
    ollamaService?: OllamaService,
    outputChannel?: vscode.OutputChannel
  ): SessionEngine {
    if (!this._instance) {
      if (!ollamaService) {
        throw new Error('OllamaService required to initialize SessionEngine singleton.');
      }
      this._instance = new SessionEngine(ollamaService, outputChannel);
    }
    return this._instance;
  }

  public static resetInstance(): void {
    if (this._instance) {
      this._instance.stopGeneration();
    }
    this._instance = undefined;
  }

  /**
   * Universal thought token scrubber that eliminates multiline, case-insensitive,
   * and unclosed trailing <think> blocks without leaking reasoning tokens into context.
   */
  public static stripThoughtTokens(text: string): string {
    if (!text) return '';
    return text
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
      .trim();
  }

  public setEvents(events: SessionEngineEvents): void {
    this._events = { ...this._events, ...events };
  }

  public updateEventListeners(events: Partial<SessionEngineEvents>): void {
    this._events = { ...this._events, ...events };
  }

  public getSessionId(): string {
    return this._sessionId;
  }

  public setSessionId(id: string): void {
    this._sessionId = id;
  }

  public getMode(): SessionMode {
    return this._mode;
  }

  public setMode(mode: SessionMode): void {
    this._mode = mode;
  }

  public getModel(): string {
    return this._model;
  }

  public setModel(model: string): void {
    this._model = model;
  }

  public setCachedModels(models: string[]): void {
    this._cachedModels = models;
  }

  public isGenerating(): boolean {
    return this._isGenerating;
  }

  public isAutonomous(): boolean {
    return this._isAutonomousMode;
  }

  public setAutonomous(val: boolean): void {
    this._isAutonomousMode = val;
  }

  public getHistory(): ChatMessage[] {
    return [...this._chatHistory];
  }

  public setHistory(history: ChatMessage[]): void {
    this._chatHistory = [...history];
    this._events.onHistoryUpdated?.(this.getHistory());
  }

  public resolveApproval(id: string, approved: boolean): void {
    const resolver = this._pendingApprovals.get(id);
    if (resolver) {
      resolver(approved);
      this._pendingApprovals.delete(id);
    }
  }

  public resolveUserAnswer(answer: string): void {
    if (this._pendingUserAnswerResolver) {
      this._pendingUserAnswerResolver(answer);
      this._pendingUserAnswerResolver = undefined;
    } else if (this._currentAgent) {
      this._currentAgent.resume(answer);
    }
  }

  public stopGeneration(): void {
    if (this._isGenerating && this._currentAbortController) {
      this._log('[SessionEngine] Aborting active generation turn...');
      this._currentAbortController.abort();
      this._isGenerating = false;
      this._currentAbortController = undefined;
      this._events.onStreamError?.('Generation stopped by user.');
    }
  }

  public async clearHistory(sessionRootUri?: vscode.Uri): Promise<void> {
    this._chatHistory = [];
    this._events.onHistoryUpdated?.([]);
    const fileUri = this._getHistoryFileUri(sessionRootUri);
    if (fileUri) {
      try {
        await vscode.workspace.fs.delete(fileUri, { useTrash: false });
      } catch {}
    }
  }

  public resolveAutoModel(text: string, mode: SessionMode): string {
    const decision = ModelRouter.classifyIntent(
      text,
      mode === 'agent' ? 'agent' : 'chat',
      this._cachedModels,
      undefined,
      undefined,
      undefined,
      this._model
    );
    return decision.model || this._model || this._cachedModels[0] || '';
  }

  private _getHistoryFileUri(targetRootUri?: vscode.Uri): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const folder = targetRootUri
      ? WorkspaceManager.getTargetWorkspaceFolder(targetRootUri)
      : WorkspaceManager.getTargetWorkspaceFolder();
    const baseUri = folder?.uri || folders[0].uri;
    return vscode.Uri.joinPath(baseUri, '.vscode', 'local-copilot', 'chat_history.json');
  }

  public async saveChatHistoryToDisk(targetRootUri?: vscode.Uri): Promise<void> {
    const fileUri = this._getHistoryFileUri(targetRootUri);
    if (!fileUri) return;
    await AtomicFileWriter.writeJson(fileUri, this._chatHistory);
  }

  public async loadChatHistoryFromDisk(targetRootUri?: vscode.Uri): Promise<ChatMessage[]> {
    const fileUri = this._getHistoryFileUri(targetRootUri);
    if (!fileUri) return [];
    try {
      const parsed = await AtomicFileWriter.readJson<any[]>(fileUri, []);
      if (Array.isArray(parsed)) {
        this._chatHistory = parsed.map((item: any) => ({
          role: item.role,
          content: typeof item.content === 'string'
            ? SessionEngine.stripThoughtTokens(item.content)
            : ''
        }));
        this._events.onHistoryUpdated?.(this.getHistory());
        return this.getHistory();
      }
    } catch {}
    return [];
  }

  private _log(msg: string): void {
    const time = new Date().toLocaleTimeString();
    const safeMsg = ExtensionLogger.redact(msg);
    const line = `[${time}] ${safeMsg}`;
    console.log(line);
    this._outputChannel?.appendLine(line);
  }

  /**
   * Dispatches a user message turn through the engine with single-flight mutex protection.
   */
  public async sendMessage(
    userText: string,
    options?: SendMessageOptions
  ): Promise<string> {
    if (!userText || !userText.trim()) {
      return '';
    }

    // DEFECT-HIGH-03 / Invariant 1: Single-flight generation guard.
    if (this._isGenerating) {
      this._log('[SessionEngine] Rejected sendMessage: generation already active.');
      const err = new GenerationActiveError();
      this._events.onStreamError?.(err.message);
      throw err;
    }

    const generationId = ++this._generationCounter;
    this._currentGenerationId = generationId;
    this._isGenerating = true;

    const mode = options?.mode ?? this._mode;
    this._mode = mode;

    if (options?.autonomousMode !== undefined) {
      this._isAutonomousMode = options.autonomousMode;
    }

    this._currentAbortController = new AbortController();
    const signal = this._currentAbortController.signal;
    const config = ConfigurationService.getInstance();

    const rawModel = options?.model ?? this._model;
    const isAuto = (!rawModel || rawModel.toLowerCase() === 'auto');
    const resolvedModel = isAuto ? this.resolveAutoModel(userText, mode) : rawModel;
    this._model = resolvedModel;

    let assistantResponse = '';
    const startTime = Date.now();
    const targetFolder = WorkspaceManager.getTargetWorkspaceFolder();
    const sessionRootUri = targetFolder?.uri;

    try {
      const trimmed = userText.trim();

      this._events.onStartStream?.({
        userText,
        mode,
        model: isAuto ? `${resolvedModel} (Auto)` : resolvedModel
      });

      // Slash command router
      if (trimmed.startsWith('/')) {
        const parts = trimmed.split(/\s+/);
        const slashCmd = parts[0].toLowerCase();
        const rest = trimmed.slice(slashCmd.length).trim();

        const handledOutput = await this._handleSlashCommand(slashCmd, rest, resolvedModel, sessionRootUri, signal);
        if (handledOutput !== null) {
          this._events.onToken?.(handledOutput);
          this._events.onStreamEnd?.({
            response: handledOutput,
            cleanResponse: handledOutput,
            durationMs: Date.now() - startTime
          });
          return handledOutput;
        }
      }

      const numCtx = config.numCtx;
      const temperature = config.temperature;
      const maxTurns = config.maxTurns;

      // Model lifecycle switch
      if (typeof (this._ollamaService as any).getLoadedModels === 'function') {
        const lifecycle = ModelLifecycleManager.getInstance(this._ollamaService, config);
        try {
          await lifecycle.switchModel(resolvedModel);
        } catch (switchErr: any) {
          this._log(`[SessionEngine] Model switch note: ${switchErr?.message || switchErr}`);
        }
        lifecycle.notifyGenerationStart(resolvedModel);
      }

      // =========================================================================
      // BRANCH A: CHAT MODE
      // =========================================================================
      if (mode === 'chat') {
        let enrichedPrompt = userText;
        const mentionsWorkspace = /\b(project|workspace|repo|repository|codebase|solution)\b/i.test(userText);
        if (userText.includes('@workspace') || mentionsWorkspace) {
          const workspaceSummary = await WorkspaceContextService.getWorkspaceSummary(targetFolder || undefined);
          enrichedPrompt = `${workspaceSummary}\n\nUser Question:\n${userText.replace('@workspace', '').trim()}`;
        }

        this._chatHistory.push({ role: 'user', content: enrichedPrompt });

        const timeouts: OllamaTimeoutOptions = {
          connectTimeoutMs: config.connectTimeout,
          idleStreamTimeoutMs: config.idleStreamTimeout,
          totalTimeoutMs: config.totalGenerationTimeout
        };

        const keepAlive = config.modelUnloadPolicy === 'unloadImmediately'
          ? 0
          : (config.modelKeepAliveDuration || '5m');

        assistantResponse = '';
        await this._ollamaService.streamChat(
          resolvedModel,
          this._chatHistory,
          (chunk) => {
            assistantResponse += chunk;
            this._events.onToken?.(chunk);
          },
          signal,
          { num_ctx: numCtx, temperature, keep_alive: keepAlive },
          timeouts
        );

        if (signal.aborted) {
          this._log('[SessionEngine] Generation was aborted.');
          this._events.onStreamError?.('Generation stopped.');
          return '';
        }

        const cleanAssistantResponse = SessionEngine.stripThoughtTokens(assistantResponse);
        this._chatHistory.push({ role: 'assistant', content: cleanAssistantResponse });
        this._events.onHistoryUpdated?.(this.getHistory());
        await this.saveChatHistoryToDisk(sessionRootUri);

        this._events.onStreamEnd?.({
          response: assistantResponse,
          cleanResponse: cleanAssistantResponse,
          durationMs: Date.now() - startTime
        });

        return cleanAssistantResponse;
      }

      // =========================================================================
      // BRANCH B: PLAN MODE (Read-Only Planning Without Tool Execution)
      // =========================================================================
      if (mode === 'plan') {
        const planSystemPrompt =
          'You are an expert software architect in PLAN MODE. ' +
          'Analyze the user request and project context thoroughly. ' +
          'Produce a comprehensive, step-by-step implementation plan including: ' +
          '1. Architectural strategy and components affected. ' +
          '2. Concrete files to create, modify, or delete. ' +
          '3. Verification, testing, and rollback strategy. ' +
          'Do NOT execute tools or modify files. Plan mode is strictly read-only.';

        const planMessages: ChatMessage[] = [
          { role: 'system', content: planSystemPrompt },
          ...this._chatHistory,
          { role: 'user', content: userText }
        ];

        assistantResponse = '';
        await this._ollamaService.streamChat(
          resolvedModel,
          planMessages,
          (chunk) => {
            assistantResponse += chunk;
            this._events.onToken?.(chunk);
          },
          signal,
          { num_ctx: numCtx, temperature: 0.1 }
        );

        if (signal.aborted) {
          this._log('[SessionEngine] Generation was aborted.');
          this._events.onStreamError?.('Generation stopped.');
          return '';
        }

        const cleanPlanResponse = SessionEngine.stripThoughtTokens(assistantResponse);
        this._chatHistory.push({ role: 'user', content: userText });
        this._chatHistory.push({ role: 'assistant', content: cleanPlanResponse });
        this._events.onHistoryUpdated?.(this.getHistory());
        await this.saveChatHistoryToDisk(sessionRootUri);

        this._events.onStreamEnd?.({
          response: assistantResponse,
          cleanResponse: cleanPlanResponse,
          durationMs: Date.now() - startTime
        });

        return cleanPlanResponse;
      }

      // =========================================================================
      // BRANCH C: AGENT MODE (Hierarchical Swarm Orchestrator)
      // =========================================================================
      this._currentAgent = new SwarmOrchestrator(this._ollamaService, {
        maxTurns,
        numCtx,
        temperature,
        autonomousMode: this._isAutonomousMode,
        userModel: resolvedModel,
        availableModels: this._cachedModels.length > 0 ? this._cachedModels : [resolvedModel],
        workspaceRootUri: sessionRootUri
      });

      const finalResult = await this._currentAgent.runTask(
        userText,
        {
          onStatusUpdate: (status: string) => {
            this._events.onAgentStatus?.(status);
          },
          onProgress: (event: ProgressEvent) => {
            this._events.onAgentProgress?.(event);
          },
          onThought: (chunk: string) => {
            this._events.onThought?.(chunk);
          },
          onText: (chunk: string) => {
            assistantResponse += chunk;
            this._events.onToken?.(chunk);
          },
          onToolStart: (call: ToolCall) => {
            this._events.onToolStart?.(call);
          },
          onToolEnd: (result: ToolResult) => {
            this._events.onToolEnd?.(result);
          },
          requestApproval: async (req: ApprovalRequest): Promise<boolean> => {
            if (this._events.onRequestApproval) {
              const res = await this._events.onRequestApproval(req);
              if (typeof res === 'boolean') return res;
            }
            return new Promise<boolean>((resolve) => {
              this._pendingApprovals.set(req.id, resolve);
            });
          },
          onAskUser: async (question: string): Promise<string> => {
            if (this._events.onAskUser) {
              const ans = await this._events.onAskUser(question);
              if (typeof ans === 'string') return ans;
            }
            return new Promise<string>((resolve) => {
              this._pendingUserAnswerResolver = resolve;
            });
          }
        },
        signal
      );

      const cleanResult = SessionEngine.stripThoughtTokens(finalResult);
      this._chatHistory.push({ role: 'user', content: userText });
      this._chatHistory.push({ role: 'assistant', content: cleanResult });
      this._events.onHistoryUpdated?.(this.getHistory());
      await this.saveChatHistoryToDisk(sessionRootUri);

      this._events.onStreamEnd?.({
        response: finalResult,
        cleanResponse: cleanResult,
        durationMs: Date.now() - startTime
      });

      return cleanResult;

    } catch (err: any) {
      if (signal.aborted || err.name === 'AbortError') {
        this._log('[SessionEngine] Generation was aborted.');
        this._events.onStreamError?.('Generation stopped.');
        return '';
      }
      this._log(`[SessionEngine] Error during generation: ${err.message || err}`);
      this._events.onStreamError?.(err.message || String(err));
      throw err;
    } finally {
      if (this._currentGenerationId === generationId) {
        this._isGenerating = false;
        this._currentAbortController = undefined;
        this._currentAgent = undefined;
      }
    }
  }

  /**
   * Internal slash command handler. Returns output string if handled, or null to proceed with normal LLM inference.
   */
  private async _handleSlashCommand(
    slashCmd: string,
    rest: string,
    resolvedModel: string,
    sessionRootUri?: vscode.Uri,
    signal?: AbortSignal
  ): Promise<string | null> {
    switch (slashCmd) {
      case '/diff': {
        try {
          const diff = await AgentToolService.getGitDiff();
          return `### 🔍 Workspace Git Diff\n\`\`\`diff\n${diff}\n\`\`\``;
        } catch (err: any) {
          return `### 🔍 Workspace Git Diff\n❌ Failed to retrieve Git diff: ${err.message}`;
        }
      }

      case '/build': {
        const buildRes = await AgentToolService.checkBuild();
        return `### 🔨 Workspace Build Check\n${buildRes.success ? '✅ Build succeeded!' : '❌ Build failed.'}\n\`\`\`\n${buildRes.output}\n\`\`\``;
      }

      case '/clear': {
        await this.clearHistory(sessionRootUri);
        return '🧹 Session history cleared.';
      }

      case '/fix': {
        this._log(`[SessionEngine] Executing /fix debugging workflow...`);
        const fixRes = await AutonomousDebuggerService.executeFixWorkflow(
          rest,
          this._ollamaService,
          resolvedModel,
          (statusMsg: string) => {
            this._events.onToken?.('\n\n' + statusMsg);
          },
          signal,
          sessionRootUri
        );
        return `\n\n### 🔧 Fix Workflow Result\n${fixRes.message}`;
      }

      case '/search': {
        if (!rest.trim()) {
          return '⚠️ Please provide a search query. Example: `/search authenticateUser`';
        }
        const results = await AgentToolService.searchWorkspace(rest.trim(), 10);
        return results || 'No matching symbols or text found in workspace.';
      }

      case '/read': {
        if (!rest.trim()) {
          return '⚠️ Please provide a relative file path. Example: `/read src/index.ts`';
        }
        try {
          PathSecurity.validatePath(rest.trim(), sessionRootUri);
          const content = await AgentToolService.readFile(rest.trim());
          return `📄 **File Content: \`${rest.trim()}\`**\n\`\`\`\n${content}\n\`\`\``;
        } catch (err: any) {
          return `❌ Failed to read \`${rest.trim()}\`: ${err.message}`;
        }
      }

      case '/commit': {
        try {
          const statusRes = await AgentToolService.executeCommand('git status --short');
          const diffRes = await AgentToolService.executeCommand('git diff --stat');
          const changes = statusRes.stdout.trim();
          if (!changes) {
            return '✅ Working tree clean. No changes to commit.';
          }
          let msg = `### 📦 Reviewable Commit Workflow\n\n**Changed Files:**\n\`\`\`\n${changes}\n\`\`\`\n\n`;
          if (diffRes.stdout.trim()) {
            msg += `**Diff Summary:**\n\`\`\`\n${diffRes.stdout.trim()}\n\`\`\`\n\n`;
          }
          msg += `> 💡 To commit, stage and commit through VS Code Source Control or your terminal.\n`;
          msg += `Suggested commit message:\n\`\`\`\nfeat: update workspace implementation\n\`\`\``;
          return msg;
        } catch (err: any) {
          return `❌ Git inspection failed: ${err.message}`;
        }
      }

      case '/tune': {
        const targetModel = rest.trim() || resolvedModel;
        this._events.onToken?.(`### 🎛️ Model Calibration Wizard\nStarting calibration on \`${targetModel}\`...\n\n`);
        const calibRes = await CalibrationWizard.calibrateModel(targetModel, {
          ollamaService: this._ollamaService,
          onProgress: p => {
            this._events.onToken?.(`> [${p.progressPercent}%] ${p.message}\n`);
          },
          baseDir: sessionRootUri?.fsPath
        });

        if (!calibRes.success) {
          return `\n❌ **Calibration Failed**: ${calibRes.errorMessage}`;
        }

        const profile = calibRes.profile!;
        return (
          `\n✅ **Calibration Complete for \`${targetModel}\`**\n\n` +
          `| Metric | Calibrated Value |\n` +
          `|---|---|\n` +
          `| **Steady-State Throughput** | ${profile.measuredTps} tok/s |\n` +
          `| **Cold Load / Swap Cost** | ${profile.swapCostMs}ms |\n` +
          `| **Tool Call Reliability** | ${Math.round(profile.toolCallReliability * 100)}% |\n` +
          `| **Profile Location** | \`${calibRes.profilePath || 'Workspace disk'}\` |\n\n` +
          `> Model profile saved. The swap-cost aware ModelRouter can now use this profile for intelligent routing.`
        );
      }

      case '/help': {
        return (
          '### 🤖 Local Copilot Commands\n\n' +
          '- `/plan <request>`: Switch to read-only plan mode without executing code.\n' +
          '- `/diff`: Show active git diff.\n' +
          '- `/build`: Run project build check.\n' +
          '- `/fix <issue>`: Autonomous debugging and error diagnosis.\n' +
          '- `/tune [model]`: Calibrate local model throughput, swap latency, and tool reliability.\n' +
          '- `/search <query>`: Fast symbol and text search.\n' +
          '- `/read <path>`: View workspace file content.\n' +
          '- `/commit`: Review changed files and commit proposal.\n' +
          '- `/clear`: Clear active conversation history.'
        );
      }

      default:
        return null;
    }
  }
}
