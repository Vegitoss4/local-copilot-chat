import * as vscode from 'vscode';
import { OllamaService, ChatMessage } from './ollamaService';
import { AgentToolService, ToolCall, ToolResult } from './agentToolService';
import { CommandClassifier, CommandTier } from './commandClassifier';
import { PathSecurity } from './pathSecurity';
import { WorkspaceDiscoveryService, WorkspaceDiscoveryResult } from './workspaceDiscoveryService';
import { ExploreBeforeAskGate } from './exploreBeforeAskGate';
import { ConfigurationService } from './configurationService';
import { ConversationContextManager } from './conversationContextManager';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, any>;
  description: string;
}

export interface ProgressEvent {
  icon: string;
  message: string;
  detail?: string;
  agentRole?: 'orchestrator' | 'planner' | 'coder' | 'tester';
  agentName?: string;
  agentColor?: string;
}

export interface AgentCallbacks {
  onThought?: (chunk: string) => void;
  onText?: (chunk: string) => void;
  onStatusUpdate?: (status: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (result: ToolResult) => void;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  onAskUser?: (question: string) => Promise<string>;
}

export interface AgentOptions {
  maxIterations?: number;
  maxTurns?: number;
  numCtx?: number;
  temperature?: number;
  autonomousMode?: boolean;
  userModel: string;
  availableModels: string[];
  workspaceRootUri?: vscode.Uri;
  priorConversation?: ChatMessage[];
}

export class AutonomousAgent {
  private ollamaService: OllamaService;
  private messageHistory: ChatMessage[] = [];
  private maxIterations: number;
  private numCtx: number;
  private temperature: number;
  private autonomousMode: boolean;
  private userModel: string;
  private availableModels: string[];
  private _sessionRootUri?: vscode.Uri;
  private priorConversation?: ChatMessage[];
  private pendingUserAnswerResolver?: (answer: string) => void;
  private discoveryResult?: WorkspaceDiscoveryResult;
  private exploreGate?: ExploreBeforeAskGate;

  constructor(ollamaService: OllamaService, options: AgentOptions) {
    this.ollamaService = ollamaService;
    this.maxIterations = options.maxTurns ?? options.maxIterations ?? 20;
    this.numCtx = options.numCtx ?? 16384;
    this.temperature = options.temperature ?? 0.2;
    this.autonomousMode = options.autonomousMode ?? true;
    this.userModel = options.userModel;
    this.availableModels = options.availableModels;
    this._sessionRootUri = options.workspaceRootUri;
    this.priorConversation = options.priorConversation;
  }

  public setAutonomousMode(enabled: boolean) {
    this.autonomousMode = enabled;
  }

  /**
   * Resumes an execution loop that was paused waiting for ask_user input
   */
  public resume(userAnswer: string) {
    if (this.pendingUserAnswerResolver) {
      this.pendingUserAnswerResolver(userAnswer);
      this.pendingUserAnswerResolver = undefined;
    }
  }

  /**
   * Alias for executeTask
   */
  public async runTask(
    userGoal: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    return this.executeTask(userGoal, callbacks, signal);
  }

  /**
   * Primary Autonomous ReAct Loop (Reasoning + Acting + Self-Healing)
   */
  public async executeTask(
    userGoal: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    callbacks.onStatusUpdate?.('Initializing Autonomous ReAct Loop...');
    callbacks.onProgress?.({
      icon: '🚀',
      message: 'Agent initialized goal: ' + (userGoal.slice(0, 70) + (userGoal.length > 70 ? '...' : ''))
    });

    const config = ConfigurationService.getInstance();
    let discoveryResult: WorkspaceDiscoveryResult | undefined;
    if (config.enableWorkspaceDiscoveryPreStep) {
      callbacks.onStatusUpdate?.('Scanning workspace structure and manifests...');
      discoveryResult = await WorkspaceDiscoveryService.discover(this._sessionRootUri, {
        numCtx: this.numCtx,
        signal,
      });
      this.discoveryResult = discoveryResult;
    }

    const refRes = ConversationContextManager.resolveReferentialObjective(
      userGoal,
      this.priorConversation || []
    );

    if (refRes.requiresClarification) {
      callbacks.onStatusUpdate?.('Clarification required: No prior context for referential request.');
      return refRes.clarificationQuestion || 'What specific changes or files would you like to implement?';
    }

    let effectiveUserGoal = refRes.effectiveObjective;

    const priorContextResult = ConversationContextManager.formatPriorContext(
      this.priorConversation || [],
      {
        maxPriorTurns: config.maxPriorTurns,
        tokenBudget: config.tokenBudget,
        enableLlmSummary: config.enableLlmSummary,
      }
    );

    let modelHasTools = true;
    try {
      const caps = await this.ollamaService.getModelCapabilities(this.userModel);
      modelHasTools = caps.hasTools;
    } catch {}

    const generationId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.exploreGate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: config.minExplorationBeforeAsk,
      maxClarificationQuestionsPerTask: config.maxClarificationQuestionsPerTask,
      hasRelevantFiles: discoveryResult ? discoveryResult.hasRelevantFiles : true,
      hasToolSupport: modelHasTools,
      discoveryResult,
      generationId,
      hasPriorContext: priorContextResult.hasPriorContext,
      isReferential: refRes.isReferential,
    });

    if (priorContextResult.hasPriorContext) {
      effectiveUserGoal = `${priorContextResult.formattedContext}\n\n${effectiveUserGoal}`;
    }
    if (discoveryResult) {
      effectiveUserGoal += `\n\n${discoveryResult.rawText}`;
    }

    const systemPrompt = this.buildSystemPrompt();
    this.messageHistory = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: effectiveUserGoal }
    ];

    // ==========================================
    // PHASE 1: Architectural Planning (User Selected / Role-Configured)
    // ==========================================
    const planningRes = this.ollamaService.resolveModelForPhase('planning', this.userModel, this.availableModels, { prompt: userGoal });
    const planningModel = planningRes.model;
    callbacks.onStatusUpdate?.(`Phase 1: Architectural Planning with [${planningModel}] (${planningRes.source})...`);
    callbacks.onProgress?.({
      icon: '🧠',
      message: `Analyzing architecture and planning steps with ${planningModel} (${planningRes.source})...`
    });

    let planResponse = '';
    try {
      const planPromptMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${userGoal}\n\nTask: Analyze the requirements, inspect the project structure, plan the exact files and methods to create or modify, and anticipate any compilation or runtime pitfalls. Provide a concise step-by-step execution roadmap.`
        }
      ];

      planResponse = await this.ollamaService.streamChat(
        planningModel,
        planPromptMessages,
        (chunk) => {
          if (chunk.includes('<think>') || planResponse.includes('<think>')) {
            callbacks.onThought?.(chunk);
          } else {
            callbacks.onText?.(chunk);
          }
        },
        signal
      );

      this.messageHistory.push({
        role: 'assistant',
        content: planResponse
      });

      callbacks.onProgress?.({
        icon: '📋',
        message: 'Roadmap planned. Commencing autonomous execution loop.'
      });
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      callbacks.onStatusUpdate?.(`Planning fallback: ${err.message}. Transitioning to execution...`);
    }

    if (signal?.aborted) throw new Error('Task aborted by user.');

    // ==========================================
    // PHASE 2: Iterative ReAct Execution Loop (User Selected / Role-Configured)
    // ==========================================
    const execRes = this.ollamaService.resolveModelForPhase('execution', this.userModel, this.availableModels, { prompt: userGoal });
    const execModel = execRes.model;
    callbacks.onStatusUpdate?.(`Phase 2: Autonomous Tool Execution with [${execModel}] (${execRes.source})...`);
    callbacks.onProgress?.({
      icon: '🤖',
      message: `Autonomous execution with ${execModel} (${execRes.source})...`
    });

    let iteration = 0;
    let finalAnswer = '';

    while (iteration < this.maxIterations) {
      if (signal?.aborted) throw new Error('Task aborted by user.');
      iteration++;

      callbacks.onStatusUpdate?.(`ReAct Iteration [${iteration}/${this.maxIterations}]...`);

      // Compaction: Check context length
      this.compactContextIfNecessary();

      // Query model for next action / tool calls
      let assistantMsg: ChatMessage;
      try {
        assistantMsg = await this.ollamaService.chatWithTools(
          execModel,
          this.messageHistory,
          AgentToolService.TOOL_DEFINITIONS,
          signal,
          {
            num_ctx: this.numCtx,
            temperature: Math.min(this.temperature, 0.1),
          }
        );
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;
        callbacks.onStatusUpdate?.(`Execution error: ${err.message}`);
        callbacks.onProgress?.({
          icon: '⚠️',
          message: 'Error communicating with model: ' + err.message
        });
        break;
      }

      this.messageHistory.push(assistantMsg);

      if (assistantMsg.content) {
        callbacks.onText?.('\n' + assistantMsg.content);
      }

      // Check if model emitted tool calls
      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Model emitted final answer without requesting tools -> Execution Complete!
        finalAnswer = assistantMsg.content || 'Task completed successfully.';
        callbacks.onProgress?.({
          icon: '✅',
          message: 'Task complete! All operations finished.'
        });
        break;
      }

      // Execute all tool calls emitted in this turn
      for (const call of toolCalls) {
        if (signal?.aborted) throw new Error('Task aborted by user.');

        const toolName = call.function.name;
        const args = typeof call.function.arguments === 'string'
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;

        const callId = call.id || `call_${Math.random().toString(36).slice(2, 9)}`;
        const toolCallObj: ToolCall = { id: callId, function: { name: toolName, arguments: args } };

        callbacks.onToolStart?.(toolCallObj);

        // --- SPECIAL HANDLING: ask_user (Pause & Clarify) ---
        if (toolName === 'ask_user') {
          const questionText = args.question || 'Please provide clarification.';

          if (this.exploreGate) {
            const gateRes = this.exploreGate.evaluateAskUser(questionText);
            if (!gateRes.allowed) {
              callbacks.onProgress?.({
                icon: '🛡️',
                message: 'Explore gate rejected early clarification: Inspect workspace first.'
              });
              const askResult: ToolResult = {
                toolCallId: callId,
                name: toolName,
                success: false,
                output: gateRes.reason || 'Rejection: Inspect workspace first.'
              };
              callbacks.onToolEnd?.(askResult);
              this.messageHistory.push({
                role: 'tool',
                name: toolName,
                content: `Gate Rejection: ${gateRes.reason}`
              });
              continue;
            }
          }

          callbacks.onStatusUpdate?.(`Waiting for user input: "${questionText}"`);
          callbacks.onProgress?.({
            icon: '❓',
            message: `Agent paused: Waiting for clarification: "${questionText}"`,
            detail: questionText
          });

          let userAnswer = '';
          if (callbacks.onAskUser) {
            userAnswer = await callbacks.onAskUser(questionText);
          } else {
            userAnswer = await new Promise<string>((resolve) => {
              this.pendingUserAnswerResolver = resolve;
            });
          }

          callbacks.onProgress?.({
            icon: '💬',
            message: `User responded: "${userAnswer}". Resuming execution.`
          });

          const askResult: ToolResult = {
            toolCallId: callId,
            name: toolName,
            success: true,
            output: `User Answer: ${userAnswer}`
          };
          callbacks.onToolEnd?.(askResult);

          this.messageHistory.push({
            role: 'tool',
            name: toolName,
            content: `User Answer: ${userAnswer}`
          });
          continue;
        }

        // Emit descriptive progress message based on tool
        this.emitToolProgressStart(callbacks, toolName, args);

        // Command security pre-check
        let commandTier: CommandTier | undefined;
        if (toolName === 'execute_command') {
          try {
            const classification = CommandClassifier.classify(args.command || '');
            commandTier = classification.tier;
            if (classification.tier === CommandTier.TIER_4_PROHIBITED) {
              const prohibitedResult: ToolResult = {
                toolCallId: callId,
                name: toolName,
                success: false,
                output: `Command rejected by security policy: ${classification.reason}`,
              };
              callbacks.onToolEnd?.(prohibitedResult);
              this.messageHistory.push({
                role: 'tool',
                name: toolName,
                content: prohibitedResult.output,
              });
              continue;
            }
          } catch (err: any) {
            const syntaxErrResult: ToolResult = {
              toolCallId: callId,
              name: toolName,
              success: false,
              output: `Command syntax rejected: ${err.message}`,
            };
            callbacks.onToolEnd?.(syntaxErrResult);
            this.messageHistory.push({
              role: 'tool',
              name: toolName,
              content: syntaxErrResult.output,
            });
            continue;
          }
        }

        // Human-in-the-Loop Safety Check:
        // 1. In non-autonomous mode: all destructive tools require approval.
        // 2. In autonomous mode: Tier 2 and Tier 3 commands require approval as an unbypassable guardrail.
        // 3. Sensitive Target Defense: Any tool modifying sensitive files (.github, .git, package.json scripts, .env) requires approval even in autonomous mode.
        // 4. Batch Hard Cap: Any transactional patch touching > 10 files requires approval.
        const isDestructive = AgentToolService.isDestructiveTool(toolName);
        let touchesSensitiveTarget = false;

        if (toolName === 'create_file' || toolName === 'str_replace' || toolName === 'apply_patch') {
          if (args.filePath && PathSecurity.isSensitiveTarget(args.filePath)) {
            touchesSensitiveTarget = true;
          }
        } else if (toolName === 'apply_transactional_patches') {
          const patches = Array.isArray(args.patches) ? args.patches : [];
          if (patches.length > 10) touchesSensitiveTarget = true; // Batch size hard cap
          for (const p of patches) {
            if (p.filePath && PathSecurity.isSensitiveTarget(p.filePath)) {
              touchesSensitiveTarget = true;
              break;
            }
          }
        }

        const requiresApproval =
          (!this.autonomousMode && isDestructive) ||
          touchesSensitiveTarget ||
          (this.autonomousMode &&
            toolName === 'execute_command' &&
            (commandTier === CommandTier.TIER_2_PROJECT_EXECUTION ||
              commandTier === CommandTier.TIER_3_ARBITRARY_COMMAND));

        if (requiresApproval) {
          if (!callbacks.requestApproval) {
            // FAIL-CLOSED
            const deniedResult: ToolResult = {
              toolCallId: callId,
              name: toolName,
              success: false,
              output: `Execution denied: Tool '${toolName}' requires user approval and no approval handler is available (fail-closed policy).`,
            };
            callbacks.onToolEnd?.(deniedResult);
            callbacks.onProgress?.({
              icon: '❌',
              message: `Action denied (fail-closed policy): ${toolName}`,
            });
            this.messageHistory.push({
              role: 'tool',
              name: toolName,
              content: deniedResult.output,
            });
            continue;
          }

          callbacks.onProgress?.({
            icon: '🛡️',
            message: `Awaiting approval to execute: ${toolName}`,
          });

          const desc = this.formatActionDescription(toolName, args);
          const approved = await callbacks.requestApproval({
            id: callId,
            toolName,
            args,
            description: desc,
          });

          if (!approved) {
            const deniedResult: ToolResult = {
              toolCallId: callId,
              name: toolName,
              success: false,
              output: `Execution denied by user for action: ${toolName}. Please choose an alternative approach or ask the user.`,
            };
            callbacks.onToolEnd?.(deniedResult);
            callbacks.onProgress?.({
              icon: '❌',
              message: `Action denied by user: ${toolName}`,
            });

            this.messageHistory.push({
              role: 'tool',
              name: toolName,
              content: deniedResult.output,
            });
            continue;
          }
        }

        // Execute the tool
        const result = await this.dispatchToolExecution(toolName, args, callId);
        if (this.exploreGate) {
          this.exploreGate.recordToolCall(toolName, args, result.success);
        }
        callbacks.onToolEnd?.(result);

        // Append tool result into context
        let toolFeedback = result.output;
        if (result.diagnostics) {
          toolFeedback += `\n\n[LSP Language Server Alert after edit]:\n${result.diagnostics}\nFix these compiler diagnostics immediately.`;
          callbacks.onProgress?.({
            icon: '⚠️',
            message: 'LSP reported diagnostics after edit. Self-correcting...',
            detail: result.diagnostics
          });
        } else if (result.success) {
          callbacks.onProgress?.({
            icon: '✅',
            message: `Successfully executed ${toolName}`
          });
        }

        this.messageHistory.push({
          role: 'tool',
          name: toolName,
          content: toolFeedback
        });
      }
    }

    if (iteration >= this.maxIterations) {
      callbacks.onStatusUpdate?.('Reached maximum iteration limit (20). Finalizing response.');
      callbacks.onProgress?.({
        icon: '🏁',
        message: 'Completed maximum iterations (20).'
      });
    }

    callbacks.onStatusUpdate?.('✅ Task execution finished.');
    return finalAnswer;
  }

  private emitToolProgressStart(callbacks: AgentCallbacks, toolName: string, args: Record<string, any>) {
    switch (toolName) {
      case 'view_file_range':
        callbacks.onProgress?.({
          icon: '🔄',
          message: `Reading ${args.filePath} (lines ${args.startLine}-${args.endLine})`
        });
        break;
      case 'str_replace':
        callbacks.onProgress?.({
          icon: '🛠️',
          message: `Applying surgical edit to ${args.filePath}`
        });
        break;
      case 'create_file':
        callbacks.onProgress?.({
          icon: '📄',
          message: `Creating file: ${args.filePath}`
        });
        break;
      case 'execute_command':
        callbacks.onProgress?.({
          icon: '⚡',
          message: `Executing shell command: ${args.command}`
        });
        break;
      case 'search_workspace':
        callbacks.onProgress?.({
          icon: '🔍',
          message: `Searching workspace for "${args.query}"`
        });
        break;
      default:
        callbacks.onProgress?.({
          icon: '⚙️',
          message: `Executing tool ${toolName}...`
        });
        break;
    }
  }

  /**
   * Dispatches and runs individual tool actions
   */
  private async dispatchToolExecution(toolName: string, args: Record<string, any>, callId: string): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'view_file_range': {
          const out = await AgentToolService.viewFileRange(args.filePath, args.startLine, args.endLine);
          return { toolCallId: callId, name: toolName, success: true, output: out };
        }
        case 'str_replace': {
          const res = await AgentToolService.strReplace(args.filePath, args.oldStr, args.newStr);
          return {
            toolCallId: callId,
            name: toolName,
            success: res.success,
            output: res.output,
            diagnostics: res.diagnostics
          };
        }
        case 'create_file': {
          const res = await AgentToolService.createFile(args.filePath, args.content);
          return {
            toolCallId: callId,
            name: toolName,
            success: res.success,
            output: res.output,
            diagnostics: res.diagnostics
          };
        }
        case 'apply_patch': {
          const res = await AgentToolService.applyPatch(args.filePath, args.patchContent);
          return { toolCallId: callId, name: toolName, success: res.success, output: res.output };
        }
        case 'apply_transactional_patches': {
          const res = await AgentToolService.applyTransactionalPatches(args.patches || [], this._sessionRootUri);
          return { toolCallId: callId, name: toolName, success: res.success, output: res.output };
        }
        case 'execute_command': {
          const res = await AgentToolService.executeCommand(args.command);
          const formatted = `Exit Code: ${res.exitCode}\nSTDOUT:\n${res.stdout || '(none)'}\nSTDERR:\n${res.stderr || '(none)'}`;
          return { toolCallId: callId, name: toolName, success: res.exitCode === 0, output: formatted };
        }
        case 'get_diagnostics': {
          const out = AgentToolService.getDiagnostics(args.filePath);
          return { toolCallId: callId, name: toolName, success: true, output: out };
        }
        case 'search_workspace': {
          const out = await AgentToolService.searchWorkspace(args.query, args.maxResults);
          return { toolCallId: callId, name: toolName, success: true, output: out };
        }
        case 'list_dir': {
          const out = await AgentToolService.listDir(args.dirPath || '');
          return { toolCallId: callId, name: toolName, success: true, output: out };
        }
        default: {
          return {
            toolCallId: callId,
            name: toolName,
            success: false,
            output: `Unknown tool: ${toolName}. Available tools: ${AgentToolService.TOOL_DEFINITIONS.map(t => t.function.name).join(', ')}`
          };
        }
      }
    } catch (err: any) {
      return { toolCallId: callId, name: toolName, success: false, output: `Internal tool error: ${err.message}` };
    }
  }

  /**
   * Rolling Context Compaction Algorithm
   */
  private compactContextIfNecessary() {
    let totalChars = 0;
    for (const msg of this.messageHistory) {
      totalChars += (msg.content?.length || 0);
    }

    const thresholdChars = Math.floor(this.numCtx * 2.5);
    if (totalChars > thresholdChars && this.messageHistory.length > 6) {
      const system = this.messageHistory[0];
      const goal = this.messageHistory[1];
      const recent = this.messageHistory.slice(-4);
      const intermediate = this.messageHistory.slice(2, -4);

      const compactedIntermediate = intermediate.map(msg => {
        if (msg.role === 'tool' && msg.content.length > 500) {
          const head = msg.content.slice(0, 200);
          const tail = msg.content.slice(-200);
          return {
            ...msg,
            content: `${head}\n...[truncated intermediate tool output]...\n${tail}`
          };
        }
        return msg;
      });

      this.messageHistory = [system, goal, ...compactedIntermediate, ...recent];
    }
  }

  private formatActionDescription(toolName: string, args: Record<string, any>): string {
    switch (toolName) {
      case 'str_replace':
        return `Modify file: \`${args.filePath}\` (replace ${args.oldStr?.length || 0} characters)`;
      case 'create_file':
        return `Create new file: \`${args.filePath}\` (${args.content?.length || 0} characters)`;
      case 'execute_command':
        return `Execute command: \`${args.command}\``;
      case 'apply_patch':
        return `Apply patch to: \`${args.filePath}\``;
      case 'apply_transactional_patches':
        return `Apply atomic transactional patches to ${args.patches?.length || 0} file(s)`;
      default:
        return `Execute action \`${toolName}\``;
    }
  }

  private buildSystemPrompt(): string {
    return `You are an elite, autonomous software engineering agent running natively inside Visual Studio Code.
You have direct read, search, surgical modification, question-asking, and command-execution capabilities across the workspace.

### Core Philosophy & Rules:
1. SURGICAL EDITING ONLY:
   - NEVER dump or rewrite an entire 300+ line file.
   - First use view_file_range to inspect the exact lines you need to edit.
   - Then use str_replace with the exact unique string to make precise changes.
   - Ensure oldStr in str_replace is unique in the file (include a few surrounding lines if needed).

2. SELF-HEALING DIAGNOSTIC LOOP:
   - After any file modification, the system automatically runs the Language Server Protocol (LSP) diagnostics.
   - If an error alert is returned (e.g. CS1002, TS2304), your NEXT priority is to view the problematic line and apply a surgical fix.
   - Use get_diagnostics or execute_command ("dotnet build" / "npm run build") to verify your fixes.

3. EXPLORE BEFORE ASKING:
   - Always inspect the workspace first using read/search tools.
   - Only invoke ask_user for decisions the workspace cannot answer (e.g. business trade-offs, credentials). Never ask about facts discoverable in files.
   - If the user input is a status statement rather than a clear task, inspect the workspace, report findings, and propose next steps.

4. EXPLORE BEFORE ASSUMING:
   - Use search_workspace or list_dir to find existing models, services, and project manifests before creating duplicates.
   - View files before editing them.

5. AUTONOMOUS PROGRESSION:
   - Continue calling tools until the entire user goal is completely fulfilled, verified, and compiling cleanly.
   - When everything is complete, provide a concise summary of the actions taken.`;
  }
}
