import * as vscode from 'vscode';
import { OllamaService, ChatMessage } from './ollamaService';
import { AgentToolService, ToolCall, ToolResult } from './agentToolService';
import { MemoryService } from './memoryService';
import {
  AgentRole,
  IAgentDefinition,
  getAgentDefinition,
  AGENT_REGISTRY
} from './agentRegistry';
import { ApprovalRequest, ProgressEvent, AgentCallbacks } from './autonomousAgent';

export { ApprovalRequest, ProgressEvent, AgentCallbacks };

export interface SwarmWhiteboard {
  userObjective: string;
  executionPlan: string;
  scratchpad: string;
  activeAgent: AgentRole;
  delegationHistory: Array<{
    from: AgentRole;
    to: AgentRole;
    task: string;
    result?: string;
    status?: string;
    timestamp: number;
  }>;
  modifiedFiles: string[];
  diagnostics: string[];
}

export interface SwarmOptions {
  maxTurns?: number;
  autonomousMode?: boolean;
  userModel: string;
  availableModels: string[];
}

export class SwarmOrchestrator {
  private ollamaService: OllamaService;
  private maxTurns: number;
  private autonomousMode: boolean;
  private userModel: string;
  private availableModels: string[];

  // Time-slicing state: track loaded model to unload before loading a new one under 8GB VRAM constraint
  private currentlyLoadedModel: string | null = null;

  // Shared Memory Bus ("Whiteboard")
  private whiteboard!: SwarmWhiteboard;

  // Active execution state
  private currentAgentRole: AgentRole = 'orchestrator';
  private pendingUserAnswerResolver?: (answer: string) => void;
  private orchestratorHistory: ChatMessage[] = [];
  private lastDelegationCallId: string | null = null;

  constructor(ollamaService: OllamaService, options: SwarmOptions) {
    this.ollamaService = ollamaService;
    this.maxTurns = options.maxTurns ?? 25;
    this.autonomousMode = options.autonomousMode ?? true;
    this.userModel = options.userModel;
    this.availableModels = options.availableModels;
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
   * Primary entry point for multi-agent swarm task execution
   */
  public async runTask(
    userGoal: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    return this.executeSwarm(userGoal, callbacks, signal);
  }

  public async executeTask(
    userGoal: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    return this.executeSwarm(userGoal, callbacks, signal);
  }

  /**
   * Main Swarm Orchestration Loop
   */
  public async executeSwarm(
    userGoal: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    callbacks.onStatusUpdate?.('Initializing Multi-Agent Swarm...');
    callbacks.onProgress?.({
      icon: '🐝',
      message: 'Swarm initialized objective: ' + (userGoal.slice(0, 65) + (userGoal.length > 65 ? '...' : '')),
      agentRole: 'orchestrator',
      agentName: 'Swarm Orchestrator',
      agentColor: '#a855f7'
    });

    // Initialize or Hydrate the Whiteboard from persistent disk storage (.vscode/local-copilot/whiteboard.json)
    const persisted = await this.loadWhiteboardFromDisk();
    const hasExistingState = persisted && (persisted.executionPlan || persisted.modifiedFiles?.length > 0);

    this.whiteboard = {
      userObjective: userGoal,
      executionPlan: persisted?.executionPlan || '',
      scratchpad: persisted?.scratchpad || '',
      activeAgent: 'orchestrator',
      delegationHistory: persisted?.delegationHistory || [],
      modifiedFiles: persisted?.modifiedFiles || [],
      diagnostics: []
    };

    if (hasExistingState) {
      callbacks.onProgress?.({
        icon: '💾',
        message: `Hydrated persistent Whiteboard: ${this.whiteboard.modifiedFiles.length} known modified files, existing roadmap restored.`,
        agentRole: 'orchestrator',
        agentName: 'Swarm Orchestrator',
        agentColor: '#a855f7'
      });
    }

    await this.saveWhiteboardToDisk();

    this.currentAgentRole = 'orchestrator';
    this.orchestratorHistory = [
      { role: 'system', content: this.buildOrchestratorPrompt() },
      { role: 'user', content: `Primary User Objective:\n${userGoal}` }
    ];

    let turns = 0;
    let finalAnswer = '';
    let isTaskFinished = false;

    // Sub-agent task instruction queued by Orchestrator
    let pendingSubTask: {
      targetRole: AgentRole;
      taskDescription: string;
      contextFiles: string[];
    } | null = null;

    while (turns < this.maxTurns && !isTaskFinished) {
      if (signal?.aborted) {
        throw new Error('Swarm task cancelled by user.');
      }

      turns++;

      // =========================================================================
      // 1. ROUTING: ORCHESTRATOR OR SUB-AGENT EXECUTION
      // =========================================================================
      if (this.currentAgentRole === 'orchestrator') {
        const orchDef = getAgentDefinition('orchestrator');
        const activeModel = await this.timeSliceModel(orchDef.role, callbacks);

        callbacks.onStatusUpdate?.('🧠 Orchestrator evaluating next move...');
        callbacks.onProgress?.({
          icon: '🧠',
          message: 'Orchestrator analyzing workflow state and planning delegations...',
          agentRole: 'orchestrator',
          agentName: orchDef.name,
          agentColor: orchDef.color
        });

        // Compact Orchestrator context if growing large
        this.compactContext(this.orchestratorHistory);

        const responseMsg = await this.ollamaService.chatWithTools(
          activeModel,
          this.orchestratorHistory,
          orchDef.tools,
          signal
        );

        this.orchestratorHistory.push(responseMsg);

        // Check if model streamed thoughts or tags
        if (responseMsg.content) {
          const thinkMatch = responseMsg.content.match(/<think>([\s\S]*?)<\/think>/);
          if (thinkMatch) {
            callbacks.onThought?.(thinkMatch[1].trim());
          }
        }

        // Handle tool calls from Orchestrator
        const toolCalls = responseMsg.tool_calls || [];
        if (toolCalls.length === 0) {
          // If no tools were called, check if Orchestrator directly gave the final answer
          if (responseMsg.content && !responseMsg.content.includes('<tool_call>')) {
            finalAnswer = responseMsg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            isTaskFinished = true;
            break;
          }
        }

        for (const call of toolCalls) {
          const callId = call.id || 'call_' + Math.random().toString(36).slice(2, 9);
          const toolName = call.function.name;
          const args = call.function.arguments || {};
          callbacks.onToolStart?.({ id: callId, function: call.function });

          if (toolName === 'delegate_task') {
            const target = (args.target_agent || '').toLowerCase() as AgentRole;
            const taskDesc = args.task_description || '';
            const ctxFiles = Array.isArray(args.context_files) ? args.context_files : [];

            if (!AGENT_REGISTRY[target]) {
              this.orchestratorHistory.push({
                role: 'tool',
                name: 'delegate_task',
                content: `Error: Target agent "${args.target_agent}" does not exist. Choose planner, coder, or tester.`
              });
              continue;
            }

            this.lastDelegationCallId = callId;
            pendingSubTask = {
              targetRole: target,
              taskDescription: taskDesc,
              contextFiles: ctxFiles
            };

            const targetDef = getAgentDefinition(target);
            callbacks.onProgress?.({
              icon: targetDef.icon,
              message: `Orchestrator delegated to ${targetDef.name}: ${taskDesc.slice(0, 70)}...`,
              agentRole: target,
              agentName: targetDef.name,
              agentColor: targetDef.color
            });

            this.whiteboard.delegationHistory.push({
              from: 'orchestrator',
              to: target,
              task: taskDesc,
              timestamp: Date.now()
            });
            await this.saveWhiteboardToDisk();

            // Switch active role to the sub-agent
            this.currentAgentRole = target;
            break; // Execute sub-agent immediately
          } else if (toolName === 'finish_task') {
            finalAnswer = args.final_summary || responseMsg.content || 'Swarm task completed.';
            isTaskFinished = true;
            await this.saveWhiteboardToDisk();
            callbacks.onProgress?.({
              icon: '🏁',
              message: 'Orchestrator finalized all tasks and verification.',
              agentRole: 'orchestrator',
              agentName: orchDef.name,
              agentColor: orchDef.color
            });
            break;
          } else if (toolName === 'ask_user') {
            const question = args.question || 'Please provide clarification.';
            callbacks.onProgress?.({
              icon: '❓',
              message: `Orchestrator paused to ask user: "${question.slice(0, 60)}..."`,
              agentRole: 'orchestrator',
              agentName: orchDef.name,
              agentColor: orchDef.color
            });

            let userAnswer = '';
            if (callbacks.onAskUser) {
              userAnswer = await callbacks.onAskUser(question);
            } else {
              userAnswer = await new Promise<string>((resolve) => {
                this.pendingUserAnswerResolver = resolve;
              });
            }

            this.orchestratorHistory.push({
              role: 'tool',
              name: 'ask_user',
              content: `User Answer: ${userAnswer}`
            });
            callbacks.onToolEnd?.({
              toolCallId: callId,
              name: 'ask_user',
              success: true,
              output: `User responded: ${userAnswer}`
            });
          } else {
            // Read-only tools available to Orchestrator (view_file_range, search_workspace, list_dir)
            const result = await this.dispatchBaseTool(toolName, args, callId, callbacks, 'orchestrator');
            this.orchestratorHistory.push({
              role: 'tool',
              name: toolName,
              content: result.output
            });
            callbacks.onToolEnd?.(result);
          }
        }
      } else if (pendingSubTask) {
        // =========================================================================
        // 2. SUB-AGENT EXECUTION (Planner, Coder, or Tester)
        // =========================================================================
        const subRole = pendingSubTask.targetRole;
        const subDef = getAgentDefinition(subRole);
        const subTaskDesc = pendingSubTask.taskDescription;
        const subContextFiles = pendingSubTask.contextFiles;

        const subModel = await this.timeSliceModel(subRole, callbacks);

        callbacks.onStatusUpdate?.(`${subDef.icon} ${subDef.name} executing assigned task...`);

        // Execute sub-agent with its own dedicated message context
        const subAgentResult = await this.executeSubAgent(
          subDef,
          subModel,
          subTaskDesc,
          subContextFiles,
          callbacks,
          signal
        );

        // Sub-agent has called hand_back (or completed)
        callbacks.onProgress?.({
          icon: '↩️',
          message: `${subDef.name} returned control: ${subAgentResult.summary.slice(0, 80)}...`,
          agentRole: subRole,
          agentName: subDef.name,
          agentColor: subDef.color
        });

        // Record in delegation history
        const lastEntry = this.whiteboard.delegationHistory[this.whiteboard.delegationHistory.length - 1];
        if (lastEntry && lastEntry.to === subRole) {
          lastEntry.result = subAgentResult.summary;
          lastEntry.status = subAgentResult.status;
        }

        // Return control back to Orchestrator by injecting tool result for delegate_task
        const orchFeedback = `[Sub-Agent ${subDef.name} (${subRole}) Execution Report - Status: ${subAgentResult.status}]\n` +
          `Summary of findings/actions:\n${subAgentResult.summary}\n\n` +
          `Current workspace modified files: ${this.whiteboard.modifiedFiles.length > 0 ? this.whiteboard.modifiedFiles.join(', ') : 'none'}`;

        this.orchestratorHistory.push({
          role: 'tool',
          name: 'delegate_task',
          content: orchFeedback
        });

        await this.saveWhiteboardToDisk();

        // Clear pending sub-task and switch back to Orchestrator
        pendingSubTask = null;
        this.currentAgentRole = 'orchestrator';
      }
    }

    if (turns >= this.maxTurns && !finalAnswer) {
      finalAnswer = 'Swarm reached maximum execution turns (' + this.maxTurns + '). Modifications and findings saved to workspace.';
    }

    // Stream final response chunks to UI
    callbacks.onText?.(finalAnswer);
    callbacks.onStatusUpdate?.('✅ Swarm task completed.');
    return finalAnswer;
  }

  /**
   * Executes a specialized sub-agent (Planner, Coder, or Tester) in an isolated, scoped multi-turn loop
   */
  private async executeSubAgent(
    subDef: IAgentDefinition,
    modelName: string,
    taskDescription: string,
    contextFiles: string[],
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<{ status: 'success' | 'failure' | 'needs_clarification'; summary: string }> {
    // Build isolated context for the sub-agent
    const subHistory: ChatMessage[] = [
      { role: 'system', content: subDef.systemPrompt },
      {
        role: 'user',
        content: this.buildSubAgentUserPrompt(subDef.role, taskDescription, contextFiles)
      }
    ];

    let subIterations = 0;
    const maxSubIterations = 8;

    while (subIterations < maxSubIterations) {
      if (signal?.aborted) throw new Error('Sub-agent execution aborted.');
      subIterations++;

      const subResponse = await this.ollamaService.chatWithTools(
        modelName,
        subHistory,
        subDef.tools,
        signal
      );

      subHistory.push(subResponse);

      // Stream thinking if present
      if (subResponse.content) {
        const thinkMatch = subResponse.content.match(/<think>([\s\S]*?)<\/think>/);
        if (thinkMatch) {
          callbacks.onThought?.(`[${subDef.name} Thought]\n${thinkMatch[1].trim()}`);
        }
      }

      const toolCalls = subResponse.tool_calls || [];
      if (toolCalls.length === 0) {
        // Sub-agent responded without tool call - treat text as completion
        const cleanContent = subResponse.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return {
          status: 'success',
          summary: cleanContent || `${subDef.name} completed instructions without additional tools.`
        };
      }

      for (const call of toolCalls) {
        const callId = call.id || 'call_' + Math.random().toString(36).slice(2, 9);
        const toolName = call.function.name;
        const args = call.function.arguments || {};
        callbacks.onToolStart?.({ id: callId, function: call.function });

        if (toolName === 'hand_back') {
          const summary = args.result_summary || 'Task completed.';
          const status = (args.status || 'success') as 'success' | 'failure' | 'needs_clarification';

          if (subDef.role === 'planner') {
            this.whiteboard.executionPlan = summary;
          } else if (subDef.role === 'tester') {
            this.whiteboard.diagnostics.push(summary);
          }
          await this.saveWhiteboardToDisk();

          callbacks.onToolEnd?.({
            toolCallId: callId,
            name: 'hand_back',
            success: status === 'success',
            output: summary
          });

          return { status, summary };
        }

        // Standard tool execution for sub-agent
        const result = await this.dispatchBaseTool(toolName, args, callId, callbacks, subDef.role);

        // Record modified file if coder edited code and index into vector memory
        if (subDef.role === 'coder' && (toolName === 'str_replace' || toolName === 'create_file' || toolName === 'apply_patch')) {
          const filePath = args.filePath;
          if (filePath && !this.whiteboard.modifiedFiles.includes(filePath)) {
            this.whiteboard.modifiedFiles.push(filePath);
            await this.saveWhiteboardToDisk();
          }

          if (result.success && filePath) {
            try {
              const fileUri = AgentToolService.getFileUri(filePath);
              const data = await vscode.workspace.fs.readFile(fileUri);
              const fileContent = new TextDecoder('utf-8').decode(data);
              const memory = MemoryService.getInstance(this.ollamaService);
              await memory.indexFile(filePath, fileContent, 'coder');
            } catch {
              // Non-blocking background indexing
            }
          }
        }

        subHistory.push({
          role: 'tool',
          name: toolName,
          content: result.diagnostics ? `${result.output}\n\n[LSP Alert]: ${result.diagnostics}` : result.output
        });

        callbacks.onToolEnd?.(result);
      }
    }

    return {
      status: 'success',
      summary: `${subDef.name} completed ${subIterations} execution iterations.`
    };
  }

  /**
   * VRAM-Aware Model Time-Slicing:
   * When switching between models (e.g. DeepSeek-R1 <-> Qwen 2.5 Coder) under an 8GB VRAM limit,
   * unloads the currently active model via keep_alive: 0 before loading the next one.
   */
  private async timeSliceModel(role: AgentRole, callbacks: AgentCallbacks): Promise<string> {
    const targetModel = this.ollamaService.resolveModelForRole(role, this.userModel, this.availableModels);

    if (this.currentlyLoadedModel && this.currentlyLoadedModel !== targetModel) {
      const prevModel = this.currentlyLoadedModel;
      callbacks.onProgress?.({
        icon: '🔄',
        message: `VRAM Time-Slice: Unloading ${prevModel} to load ${targetModel} for ${role}...`,
        agentRole: role,
        agentName: getAgentDefinition(role).name,
        agentColor: getAgentDefinition(role).color
      });

      await this.ollamaService.unloadModel(prevModel);
      this.currentlyLoadedModel = targetModel;
    } else if (!this.currentlyLoadedModel) {
      this.currentlyLoadedModel = targetModel;
    }

    return targetModel;
  }

  /**
   * Dispatches standard workspace tools with safety checks and diagnostic tracking
   */
  private async dispatchBaseTool(
    toolName: string,
    args: Record<string, any>,
    callId: string,
    callbacks: AgentCallbacks,
    role: AgentRole
  ): Promise<ToolResult> {
    const agentDef = getAgentDefinition(role);

    // Safety Tiering Check for destructive operations
    if (!this.autonomousMode && AgentToolService.isDestructiveTool(toolName)) {
      if (callbacks.requestApproval) {
        const desc = this.formatApprovalDesc(toolName, args);
        callbacks.onProgress?.({
          icon: '🛡️',
          message: `Approval requested for ${toolName} on ${args.filePath || 'command'}`,
          agentRole: role,
          agentName: agentDef.name,
          agentColor: agentDef.color
        });

        const approved = await callbacks.requestApproval({
          id: callId,
          toolName,
          args,
          description: desc
        });

        if (!approved) {
          return {
            toolCallId: callId,
            name: toolName,
            success: false,
            output: `Operation cancelled by user.`
          };
        }
      }
    }

    // Emit live UI progress
    this.emitToolProgress(callbacks, toolName, args, role);

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
        case 'semantic_search': {
          const out = await AgentToolService.semanticSearch(args.query, args.limit, args.category, this.ollamaService);
          return { toolCallId: callId, name: toolName, success: true, output: out };
        }
        case 'store_memory': {
          const res = await AgentToolService.storeMemory(args.content, args.category, args.tags, this.ollamaService);
          return { toolCallId: callId, name: toolName, success: res.success, output: res.output };
        }
        default: {
          return {
            toolCallId: callId,
            name: toolName,
            success: false,
            output: `Unknown tool: ${toolName}`
          };
        }
      }
    } catch (err: any) {
      return { toolCallId: callId, name: toolName, success: false, output: `Tool execution error: ${err.message}` };
    }
  }

  private emitToolProgress(callbacks: AgentCallbacks, toolName: string, args: Record<string, any>, role: AgentRole) {
    const def = getAgentDefinition(role);
    let msg = `Executing ${toolName}...`;
    let icon = '⚙️';

    switch (toolName) {
      case 'view_file_range':
        icon = '🔄';
        msg = `Reading ${args.filePath} (lines ${args.startLine}-${args.endLine})`;
        break;
      case 'str_replace':
        icon = '🛠️';
        msg = `Surgically editing ${args.filePath}`;
        break;
      case 'create_file':
        icon = '📄';
        msg = `Creating ${args.filePath}`;
        break;
      case 'execute_command':
        icon = '⚡';
        msg = `Running: ${args.command}`;
        break;
      case 'get_diagnostics':
        icon = '🔬';
        msg = `Auditing LSP diagnostics ${args.filePath ? `for ${args.filePath}` : 'across workspace'}`;
        break;
      case 'search_workspace':
        icon = '🔍';
        msg = `Searching workspace for "${args.query}"`;
        break;
      case 'semantic_search':
        icon = '🧠';
        msg = `Vector memory search: "${args.query}"`;
        break;
      case 'store_memory':
        icon = '💾';
        msg = `Persisting ${args.category} in vector memory`;
        break;
    }

    callbacks.onProgress?.({
      icon,
      message: msg,
      agentRole: role,
      agentName: def.name,
      agentColor: def.color
    });
  }

  private formatApprovalDesc(toolName: string, args: Record<string, any>): string {
    switch (toolName) {
      case 'str_replace':
        return `Modify file: ${args.filePath}`;
      case 'create_file':
        return `Create new file: ${args.filePath} (${(args.content || '').length} chars)`;
      case 'apply_patch':
        return `Apply patch to: ${args.filePath}`;
      case 'execute_command':
        return `Run shell command: ${args.command}`;
      default:
        return `Execute ${toolName} with arguments: ${JSON.stringify(args)}`;
    }
  }

  private buildOrchestratorPrompt(): string {
    const orchDef = getAgentDefinition('orchestrator');
    return `${orchDef.systemPrompt}\n\n` +
      `Workspace Awareness:\n` +
      `- You have a shared memory bus (Whiteboard).\n` +
      `- When delegating to sub-agents, provide clear, bite-sized tasks.\n` +
      `- Always delegate verification to 'tester' after code is modified.\n` +
      `- When done, call finish_task with the final summary.`;
  }

  private buildSubAgentUserPrompt(role: AgentRole, taskDescription: string, contextFiles: string[]): string {
    let prompt = `Assigned Sub-Task:\n${taskDescription}\n\n`;

    if (contextFiles && contextFiles.length > 0) {
      prompt += `Relevant Workspace Files:\n${contextFiles.map(f => `- ${f}`).join('\n')}\n\n`;
    }

    if (this.whiteboard.executionPlan) {
      prompt += `Overarching Execution Plan:\n${this.whiteboard.executionPlan}\n\n`;
    }

    if (this.whiteboard.modifiedFiles.length > 0) {
      prompt += `Files Already Modified in this Session:\n${this.whiteboard.modifiedFiles.map(f => `- ${f}`).join('\n')}\n\n`;
    }

    prompt += `Instructions: Perform your specific function using your available tools, and call 'hand_back' when finished.`;
    return prompt;
  }

  /**
   * Rolling Context Compaction Algorithm
   */
  private compactContext(history: ChatMessage[]) {
    let totalChars = 0;
    for (const msg of history) {
      totalChars += (msg.content?.length || 0);
    }

    // Keep context under ~40k characters (~10,000 tokens)
    if (totalChars > 40000 && history.length > 6) {
      const systemMsg = history[0];
      const initialUser = history[1];
      const recentTurns = history.slice(-4);

      // Summarize middle
      const middleSummary: ChatMessage = {
        role: 'system',
        content: `[Previous delegation intermediate outputs compacted. Whiteboard state preserved. Plan: ${this.whiteboard.executionPlan ? 'Active' : 'Pending'}. Modified files: ${this.whiteboard.modifiedFiles.join(', ') || 'none'}]`
      };

      this.orchestratorHistory = [systemMsg, initialUser, middleSummary, ...recentTurns];
    }
  }

  /**
   * Whiteboard disk persistence helpers (.vscode/local-copilot/whiteboard.json)
   */
  private getWhiteboardFileUri(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'local-copilot', 'whiteboard.json');
  }

  public async saveWhiteboardToDisk(): Promise<void> {
    const fileUri = this.getWhiteboardFileUri();
    if (!fileUri || !this.whiteboard) return;
    try {
      const dirUri = vscode.Uri.joinPath(fileUri, '..');
      await vscode.workspace.fs.createDirectory(dirUri);
      const json = JSON.stringify(this.whiteboard, null, 2);
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(json));
    } catch (err) {
      console.warn('Failed to persist whiteboard.json:', err);
    }
  }

  public async loadWhiteboardFromDisk(): Promise<SwarmWhiteboard | null> {
    const fileUri = this.getWhiteboardFileUri();
    if (!fileUri) return null;
    try {
      const data = await vscode.workspace.fs.readFile(fileUri);
      const text = new TextDecoder('utf-8').decode(data);
      const parsed = JSON.parse(text) as SwarmWhiteboard;
      return parsed;
    } catch {
      return null;
    }
  }

  public async clearWhiteboardDisk(): Promise<void> {
    const fileUri = this.getWhiteboardFileUri();
    if (!fileUri) return;
    try {
      await vscode.workspace.fs.delete(fileUri, { useTrash: false });
    } catch {}
  }
}
