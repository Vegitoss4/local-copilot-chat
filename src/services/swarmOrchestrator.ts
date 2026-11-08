import * as vscode from 'vscode';
import { OllamaService, ChatMessage } from './ollamaService';
import { AgentToolService, ToolCall, ToolResult } from './agentToolService';
import { CommandClassifier, CommandTier } from './commandClassifier';
import { PathSecurity } from './pathSecurity';
import { MemoryService } from './memoryService';
import { AtomicFileWriter } from './atomicFileWriter';
import { StructuredEditFallback } from './structuredEditFallback';
import { WorkspaceDiscoveryService, WorkspaceDiscoveryResult } from './workspaceDiscoveryService';
import { ExploreBeforeAskGate } from './exploreBeforeAskGate';
import { ConfigurationService } from './configurationService';
import { ExtensionLogger } from './extensionLogger';
import {
  AgentRole,
  IAgentDefinition,
  getAgentDefinition,
  AGENT_REGISTRY
} from './agentRegistry';
import { ApprovalRequest, ProgressEvent, AgentCallbacks } from './autonomousAgent';

export { ApprovalRequest, ProgressEvent, AgentCallbacks };

export interface SwarmTaskSnapshot {
  taskId: string;
  userObjective: string;
  executionPlan: string;
  scratchpad: string;
  modifiedFiles: string[];
  diagnostics: string[];
  delegationHistory: Array<{
    from: AgentRole;
    to: AgentRole;
    task: string;
    result?: string;
    status?: string;
    timestamp: number;
  }>;
  completed?: boolean;
  updatedAt?: number;
}

export interface SwarmWhiteboard {
  version: 2;
  activeTaskId: string;
  currentTask: SwarmTaskSnapshot;
  lastTask?: SwarmTaskSnapshot;
  projectContext?: {
    architecturalNotes: string;
    keyDecisions: string[];
  };
  // Top-level properties synchronized with currentTask for backwards compatibility
  userObjective: string;
  executionPlan: string;
  scratchpad: string;
  activeAgent: AgentRole;
  delegationHistory: SwarmTaskSnapshot['delegationHistory'];
  modifiedFiles: string[];
  diagnostics: string[];
}

export interface SwarmOptions {
  maxTurns?: number;
  numCtx?: number;
  temperature?: number;
  autonomousMode?: boolean;
  userModel: string;
  availableModels: string[];
  isContinuation?: boolean;
  workspaceRootUri?: vscode.Uri;
}

export class SwarmOrchestrator {
  private ollamaService: OllamaService;
  private maxTurns: number;
  private numCtx: number;
  private temperature: number;
  private autonomousMode: boolean;
  private userModel: string;
  availableModels: string[];
  private isContinuation: boolean;
  private workspaceRootUri?: vscode.Uri;
  private _savePromise: Promise<void> = Promise.resolve();

  // Time-slicing state: track loaded model to unload before loading a new one under 8GB VRAM constraint
  private currentlyLoadedModel: string | null = null;

  // Shared Memory Bus ("Whiteboard")
  private whiteboard!: SwarmWhiteboard;

  // Active execution state
  private currentAgentRole: AgentRole = 'orchestrator';
  private pendingUserAnswerResolver?: (answer: string) => void;
  private orchestratorHistory: ChatMessage[] = [];
  private lastDelegationCallId: string | null = null;
  private discoveryResult?: WorkspaceDiscoveryResult;
  private exploreGate?: ExploreBeforeAskGate;
  private textClarificationRetryCount = 0;

  constructor(ollamaService: OllamaService, options: SwarmOptions) {
    this.ollamaService = ollamaService;
    this.maxTurns = options.maxTurns ?? 25;
    this.numCtx = options.numCtx ?? 16384;
    this.temperature = options.temperature ?? 0.2;
    this.autonomousMode = options.autonomousMode ?? true;
    this.userModel = options.userModel;
    this.availableModels = options.availableModels;
    this.isContinuation = options.isContinuation ?? false;
    this.workspaceRootUri = options.workspaceRootUri;
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
    const isContinuation = this.isContinuation;

    let currentTaskSnapshot: SwarmTaskSnapshot;
    let lastTaskSnapshot = persisted?.lastTask;

    if (isContinuation && persisted?.currentTask) {
      // Continuation: resume ongoing task session
      currentTaskSnapshot = {
        ...persisted.currentTask,
        updatedAt: Date.now(),
      };
    } else {
      // New Task: archive previous task if present, and initialize brand new isolated task state
      if (persisted?.currentTask) {
        lastTaskSnapshot = {
          ...persisted.currentTask,
          updatedAt: Date.now(),
        };
      }
      const newTaskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      currentTaskSnapshot = {
        taskId: newTaskId,
        userObjective: userGoal,
        executionPlan: '',
        scratchpad: persisted?.scratchpad || persisted?.currentTask?.scratchpad || '',
        modifiedFiles: [],
        diagnostics: [],
        delegationHistory: [],
        completed: false,
        updatedAt: Date.now(),
      };
    }

    this.whiteboard = {
      version: 2,
      activeTaskId: currentTaskSnapshot.taskId,
      currentTask: currentTaskSnapshot,
      lastTask: isContinuation ? persisted?.lastTask : lastTaskSnapshot,
      projectContext: persisted?.projectContext || { architecturalNotes: '', keyDecisions: [] },
      userObjective: currentTaskSnapshot.userObjective,
      executionPlan: currentTaskSnapshot.executionPlan,
      scratchpad: currentTaskSnapshot.scratchpad,
      activeAgent: 'orchestrator',
      delegationHistory: currentTaskSnapshot.delegationHistory,
      modifiedFiles: currentTaskSnapshot.modifiedFiles,
      diagnostics: currentTaskSnapshot.diagnostics,
    };

    if (isContinuation && persisted?.currentTask && (currentTaskSnapshot.executionPlan || currentTaskSnapshot.modifiedFiles.length > 0)) {
      callbacks.onProgress?.({
        icon: '💾',
        message: `Continued task session (${currentTaskSnapshot.taskId}): ${currentTaskSnapshot.modifiedFiles.length} modified files and roadmap restored.`,
        agentRole: 'orchestrator',
        agentName: 'Swarm Orchestrator',
        agentColor: '#a855f7',
      });
    }

    await this.saveWhiteboardToDisk();

    const config = ConfigurationService.getInstance();
    let discoveryResult: WorkspaceDiscoveryResult | undefined;
    if (config.enableWorkspaceDiscoveryPreStep) {
      callbacks.onStatusUpdate?.('Scanning workspace structure and manifests...');
      discoveryResult = await WorkspaceDiscoveryService.discover(this.workspaceRootUri, {
        numCtx: this.numCtx,
        signal,
      });
      this.discoveryResult = discoveryResult;
    }

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
    });
    this.textClarificationRetryCount = 0;

    let initialUserContent = `Primary User Objective:\n${userGoal}`;
    if (discoveryResult) {
      initialUserContent += `\n\n${discoveryResult.rawText}`;
    }

    this.currentAgentRole = 'orchestrator';
    this.orchestratorHistory = [
      { role: 'system', content: this.buildOrchestratorPrompt() },
      { role: 'user', content: initialUserContent }
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
          signal,
          {
            num_ctx: this.numCtx,
            temperature: Math.min(this.temperature, 0.1),
          }
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
          // Check if response contains structured-edit fallback blocks
          if (responseMsg.content && (responseMsg.content.includes('FILE:') || responseMsg.content.includes('DELETE_FILE:'))) {
            const parseResult = StructuredEditFallback.parseBlocks(responseMsg.content, this.workspaceRootUri);
            if (parseResult.valid && parseResult.operations.length > 0) {
              callbacks.onStatusUpdate?.('Applying structured edits...');
              const editRes = await StructuredEditFallback.applyStructuredEdits(parseResult, this.workspaceRootUri);
              if (editRes.success) {
                finalAnswer = `Structured edits successfully applied to ${editRes.appliedOperations} file(s).`;
                isTaskFinished = true;
                break;
              } else {
                this.orchestratorHistory.push({
                  role: 'user',
                  content: `Structured edit failed: ${editRes.error}. Please retry with corrected SEARCH/REPLACE blocks.`,
                });
                continue;
              }
            }
          }

          // If no tools were called, check if Orchestrator directly gave the final answer
          if (responseMsg.content && !responseMsg.content.includes('<tool_call>')) {
            const rawAnswer = responseMsg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            // Statement vs Task / Action-or-Evidence Requirement:
            // If the turn ends solely with a clarification request while relevant files exist in the workspace,
            // retry once with an explicit instruction to inspect first, then surface honestly.
            const isClarificationQuestion =
              /\?(\s*)$/.test(rawAnswer) ||
              /(?:please\s+(?:provide|clarify|specify)|which\s+(?:framework|backend|frontend)|what\s+(?:aspects|framework|do you mean))/i.test(rawAnswer);

            if (isClarificationQuestion && this.discoveryResult?.hasRelevantFiles && this.textClarificationRetryCount < 1) {
              this.textClarificationRetryCount++;
              ExtensionLogger.warn(`[SwarmOrchestrator] Turn ended with ungrounded text clarification question. Forcing inspection retry.`);
              callbacks.onProgress?.({
                icon: '🔄',
                message: 'Clarification requested before workspace inspection. Retrying with directive to explore first...',
                agentRole: 'orchestrator',
                agentName: orchDef.name,
                agentColor: orchDef.color,
              });
              this.orchestratorHistory.push({
                role: 'user',
                content: `Do not ask clarification questions yet. Inspect the workspace first using list_dir, view_file_range, or search_workspace, and propose next steps based on what you find.`
              });
              continue;
            }

            finalAnswer = rawAnswer;
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
            // Task Verification Evidence Requirement:
            // If code was modified during this session, verify that tester reviewed diagnostics or build
            const currentMods = this.whiteboard.currentTask?.modifiedFiles || this.whiteboard.modifiedFiles || [];
            if (currentMods.length > 0) {
              const currentHistory = this.whiteboard.currentTask?.delegationHistory || this.whiteboard.delegationHistory || [];
              const hasTesterVerification = currentHistory.some(
                (d) => d.to === 'tester' && d.status === 'success'
              );
              if (!hasTesterVerification && turns < this.maxTurns - 2) {
                // Reject premature finish and request verification
                this.orchestratorHistory.push({
                  role: 'tool',
                  name: 'finish_task',
                  content: `Verification Required: You modified files (${currentMods.join(
                    ', '
                  )}), but have not yet delegated verification to 'tester'. Please delegate to 'tester' to inspect LSP diagnostics and verify the solution before completing.`,
                });
                continue;
              }
            }

            finalAnswer = args.final_summary || responseMsg.content || 'Swarm task completed.';
            isTaskFinished = true;
            if (this.whiteboard.currentTask) {
              this.whiteboard.currentTask.completed = true;
              this.whiteboard.currentTask.updatedAt = Date.now();
            }
            await this.saveWhiteboardToDisk();
            callbacks.onProgress?.({
              icon: '🏁',
              message: 'Orchestrator finalized all tasks and verification.',
              agentRole: 'orchestrator',
              agentName: orchDef.name,
              agentColor: orchDef.color,
            });
            break;
          } else if (toolName === 'ask_user') {
            const question = args.question || 'Please provide clarification.';

            // Explore-Before-Ask Gate Check
            if (this.exploreGate) {
              const gateRes = this.exploreGate.evaluateAskUser(question);
              if (!gateRes.allowed) {
                callbacks.onProgress?.({
                  icon: '🛡️',
                  message: `Explore gate rejected early clarification: Inspect workspace first.`,
                  agentRole: 'orchestrator',
                  agentName: orchDef.name,
                  agentColor: orchDef.color,
                });
                this.orchestratorHistory.push({
                  role: 'tool',
                  name: 'ask_user',
                  content: `Gate Rejection: ${gateRes.reason}`
                });
                callbacks.onToolEnd?.({
                  toolCallId: callId,
                  name: 'ask_user',
                  success: false,
                  output: gateRes.reason || 'Rejection: Inspect workspace first.'
                });
                continue;
              }
            }

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
            if (this.exploreGate) {
              this.exploreGate.recordToolCall(toolName, args, result.success);
            }
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
    const recentSignatures: string[] = [];

    while (subIterations < maxSubIterations) {
      if (signal?.aborted) throw new Error('Sub-agent execution aborted.');
      subIterations++;

      const subResponse = await this.ollamaService.chatWithTools(
        modelName,
        subHistory,
        subDef.tools,
        signal,
        {
          num_ctx: this.numCtx,
          temperature: Math.min(this.temperature, 0.1),
        }
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
        // Check for structured-edit fallback blocks
        if (subResponse.content && (subResponse.content.includes('FILE:') || subResponse.content.includes('DELETE_FILE:'))) {
          const parseResult = StructuredEditFallback.parseBlocks(subResponse.content, this.workspaceRootUri);
          if (parseResult.valid && parseResult.operations.length > 0) {
            callbacks.onStatusUpdate?.(`Applying structured edits from ${subDef.name}...`);
            const editRes = await StructuredEditFallback.applyStructuredEdits(parseResult, this.workspaceRootUri);
            if (editRes.success) {
              return {
                status: 'success',
                summary: `Applied structured edits to ${editRes.appliedOperations} file(s).`,
              };
            }
          }
        }
        // Sub-agent responded without tool call - treat text as completion
        const cleanContent = subResponse.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return {
          status: 'success',
          summary: cleanContent || `${subDef.name} completed instructions without additional tools.`
        };
      }

      // Repetition loop defense
      for (const call of toolCalls) {
        const sig = `${call.function.name}:${JSON.stringify(call.function.arguments || {})}`;
        recentSignatures.push(sig);
        if (
          recentSignatures.length >= 3 &&
          recentSignatures[recentSignatures.length - 1] === recentSignatures[recentSignatures.length - 2] &&
          recentSignatures[recentSignatures.length - 2] === recentSignatures[recentSignatures.length - 3]
        ) {
          return {
            status: 'failure',
            summary: `Sub-agent ${subDef.name} terminated: repetitive loop detected on tool '${call.function.name}'.`,
          };
        }
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
        if (this.exploreGate) {
          this.exploreGate.recordToolCall(toolName, args, result.success);
        }

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

    // Command security pre-check
    let commandTier: CommandTier | undefined;
    if (toolName === 'execute_command') {
      try {
        const classification = CommandClassifier.classify(args.command || '');
        commandTier = classification.tier;
        if (classification.tier === CommandTier.TIER_4_PROHIBITED) {
          return {
            toolCallId: callId,
            name: toolName,
            success: false,
            output: `Command rejected by security policy: ${classification.reason}`,
          };
        }
      } catch (err: any) {
        return {
          toolCallId: callId,
          name: toolName,
          success: false,
          output: `Command syntax rejected: ${err.message}`,
        };
      }
    }

    // Safety Tiering Check:
    // 1. In non-autonomous mode: all destructive tools require approval.
    // 2. In autonomous mode: Tier 2 and Tier 3 commands require approval as an unbypassable guardrail.
    // 3. Autonomous Sensitive Target Defense: Any modification to .git/, .github/, .env, package.json,
    //    or shell scripts requires developer approval even in autonomous mode (Prompt Injection Defense).
    // 4. Batch Hard Cap: Any transactional patch touching > 10 files requires approval.
    const isDestructive = AgentToolService.isDestructiveTool(toolName);
    let touchesSensitiveTarget = false;

    if (toolName === 'create_file' || toolName === 'str_replace' || toolName === 'apply_patch') {
      if (args.filePath && PathSecurity.isSensitiveTarget(args.filePath)) {
        touchesSensitiveTarget = true;
      }
    } else if (toolName === 'apply_transactional_patches') {
      const patches = Array.isArray(args.patches) ? args.patches : [];
      if (patches.length > 10) touchesSensitiveTarget = true;
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
        // FAIL-CLOSED: Approval is required but no handler provided
        return {
          toolCallId: callId,
          name: toolName,
          success: false,
          output: `Execution denied: Tool '${toolName}' requires user approval and no approval handler is available (fail-closed policy).`,
        };
      }

      const desc = this.formatApprovalDesc(toolName, args);
      callbacks.onProgress?.({
        icon: '🛡️',
        message: `Approval requested for ${toolName} on ${args.filePath || args.command || 'operation'}`,
        agentRole: role,
        agentName: agentDef.name,
        agentColor: agentDef.color,
      });

      const approved = await callbacks.requestApproval({
        id: callId,
        toolName,
        args,
        description: desc,
      });

      if (!approved) {
        return {
          toolCallId: callId,
          name: toolName,
          success: false,
          output: `Operation cancelled by user.`,
        };
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
      `- Ground your decisions in the workspace discovery facts provided.\n` +
      `- If the user's message is not a clear task or is a status statement, inspect the workspace, report what you found, and propose next steps.\n` +
      `- When delegating to sub-agents, provide clear, bite-sized tasks.\n` +
      `- Always delegate verification to 'tester' after code is modified.\n` +
      `- When done, call finish_task with the final summary.`;
  }

  private buildSubAgentUserPrompt(role: AgentRole, taskDescription: string, contextFiles: string[]): string {
    let prompt = `Assigned Sub-Task:\n${taskDescription}\n\n`;

    if (contextFiles && contextFiles.length > 0) {
      prompt += `Relevant Workspace Files:\n${contextFiles.map(f => `- ${f}`).join('\n')}\n\n`;
    }

    if (this.discoveryResult && this.discoveryResult.detectedStacks.length > 0) {
      prompt += `Workspace Tech Stacks: ${this.discoveryResult.detectedStacks.join(', ')}\n\n`;
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

    // Scale threshold dynamically from numCtx (~2.5 chars per token)
    const thresholdChars = Math.floor(this.numCtx * 2.5);
    if (totalChars > thresholdChars && history.length > 6) {
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
    const baseUri = this.workspaceRootUri || folders[0].uri;
    return vscode.Uri.joinPath(baseUri, '.vscode', 'local-copilot', 'whiteboard.json');
  }

  public async saveWhiteboardToDisk(): Promise<void> {
    const fileUri = this.getWhiteboardFileUri();
    if (!fileUri || !this.whiteboard) return;

    if (this.whiteboard.currentTask) {
      this.whiteboard.currentTask.userObjective = this.whiteboard.userObjective || this.whiteboard.currentTask.userObjective;
      this.whiteboard.currentTask.executionPlan = this.whiteboard.executionPlan || '';
      this.whiteboard.currentTask.scratchpad = this.whiteboard.scratchpad || '';
      this.whiteboard.currentTask.modifiedFiles = this.whiteboard.modifiedFiles || [];
      this.whiteboard.currentTask.diagnostics = this.whiteboard.diagnostics || [];
      this.whiteboard.currentTask.delegationHistory = this.whiteboard.delegationHistory || [];
      this.whiteboard.currentTask.updatedAt = Date.now();
    }

    await AtomicFileWriter.writeJson(fileUri, this.whiteboard);
  }

  public async loadWhiteboardFromDisk(): Promise<SwarmWhiteboard | null> {
    const fileUri = this.getWhiteboardFileUri();
    if (!fileUri) return null;
    try {
      const parsed = await AtomicFileWriter.readJson<any>(fileUri, null);

      if (!parsed || typeof parsed !== 'object') return null;

      if (parsed.version === 2 && parsed.currentTask) {
        parsed.userObjective = parsed.currentTask.userObjective || '';
        parsed.executionPlan = parsed.currentTask.executionPlan || '';
        parsed.scratchpad = parsed.currentTask.scratchpad || '';
        parsed.activeAgent = parsed.activeAgent || 'orchestrator';
        parsed.delegationHistory = parsed.currentTask.delegationHistory || [];
        parsed.modifiedFiles = parsed.currentTask.modifiedFiles || [];
        parsed.diagnostics = parsed.currentTask.diagnostics || [];
        return parsed as SwarmWhiteboard;
      }

      // Legacy v1 format migration to v2
      const legacyTaskId = parsed.taskId || `task_migrated_${Date.now()}`;
      const legacyTask: SwarmTaskSnapshot = {
        taskId: legacyTaskId,
        userObjective: parsed.userObjective || '',
        executionPlan: parsed.executionPlan || '',
        scratchpad: parsed.scratchpad || '',
        modifiedFiles: Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : [],
        diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [],
        delegationHistory: Array.isArray(parsed.delegationHistory) ? parsed.delegationHistory : [],
        completed: false,
        updatedAt: Date.now(),
      };

      const migrated: SwarmWhiteboard = {
        version: 2,
        activeTaskId: legacyTaskId,
        currentTask: legacyTask,
        lastTask: undefined,
        projectContext: { architecturalNotes: '', keyDecisions: [] },
        userObjective: legacyTask.userObjective,
        executionPlan: legacyTask.executionPlan,
        scratchpad: legacyTask.scratchpad,
        activeAgent: parsed.activeAgent || 'orchestrator',
        delegationHistory: legacyTask.delegationHistory,
        modifiedFiles: legacyTask.modifiedFiles,
        diagnostics: legacyTask.diagnostics,
      };

      return migrated;
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
