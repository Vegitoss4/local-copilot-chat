import { ExtensionLogger } from './extensionLogger';
import { WorkspaceDiscoveryResult } from './workspaceDiscoveryService';

export interface ExploreBeforeAskGateOptions {
  minExplorationBeforeAsk?: number;
  maxClarificationQuestionsPerTask?: number;
  hasRelevantFiles?: boolean;
  hasToolSupport?: boolean;
  discoveryResult?: WorkspaceDiscoveryResult;
  generationId?: string;
}

export interface GateEvaluationResult {
  allowed: boolean;
  reason?: string;
  isAdvisory?: boolean;
  escapeHatchTriggered?: boolean;
  rejectionCount: number;
  questionsAskedCount: number;
}

/**
 * Shared Explore-Before-Ask Gate & Clarification Question Budget Manager.
 * Used by SwarmOrchestrator, AutonomousAgent, and specialized sub-agents.
 */
export class ExploreBeforeAskGate {
  private readonly minExplorationBeforeAsk: number;
  private readonly maxClarificationQuestionsPerTask: number;
  private readonly hasRelevantFiles: boolean;
  private readonly hasToolSupport: boolean;
  private readonly discoveryResult?: WorkspaceDiscoveryResult;
  private readonly generationId: string;

  private distinctExplorations = new Set<string>();
  private clarificationQuestionsAsked = 0;
  private taskRejectionsCount = 0;
  private rejectedFactQuestions = new Set<string>();
  private consecutiveToolFailures = 0;

  constructor(options?: ExploreBeforeAskGateOptions) {
    this.minExplorationBeforeAsk = options?.minExplorationBeforeAsk ?? 3;
    this.maxClarificationQuestionsPerTask = options?.maxClarificationQuestionsPerTask ?? 2;
    this.hasRelevantFiles = options?.hasRelevantFiles ?? true;
    this.hasToolSupport = options?.hasToolSupport ?? true;
    this.discoveryResult = options?.discoveryResult;
    this.generationId = options?.generationId || `gen_${Date.now()}`;
  }

  public getDistinctExplorationCount(): number {
    return this.distinctExplorations.size;
  }

  public getClarificationQuestionsCount(): number {
    return this.clarificationQuestionsAsked;
  }

  public getTaskRejectionsCount(): number {
    return this.taskRejectionsCount;
  }

  /**
   * Records a tool execution.
   * Only DISTINCT successful read-only exploration calls are counted towards the gate.
   */
  public recordToolCall(
    toolName: string,
    args: Record<string, any> = {},
    success: boolean = true
  ): void {
    const readOnlyTools = new Set([
      'list_dir',
      'view_file_range',
      'search_workspace',
      'semantic_search',
      'get_diagnostics',
      'grep_search',
      'file_search'
    ]);

    if (!readOnlyTools.has(toolName)) {
      if (!success) {
        this.consecutiveToolFailures++;
      } else {
        this.consecutiveToolFailures = 0;
      }
      return;
    }

    if (!success) {
      this.consecutiveToolFailures++;
      ExtensionLogger.warn(
        `[ExploreBeforeAskGate][${this.generationId}] Read tool "${toolName}" failed. Consecutive tool failures: ${this.consecutiveToolFailures}.`
      );
      return;
    }

    this.consecutiveToolFailures = 0;

    // Derive normalized target representation to distinguish calls
    let target = '';
    if (toolName === 'list_dir') {
      target = args.path || args.dirPath || '.';
    } else if (toolName === 'view_file_range') {
      target = `${args.path || args.filePath || ''}:${args.start_line || 0}-${args.end_line || 0}`;
    } else if (toolName === 'search_workspace') {
      target = args.query || args.pattern || '';
    } else if (toolName === 'semantic_search') {
      target = args.query || '';
    } else if (toolName === 'get_diagnostics') {
      target = args.path || 'workspace';
    } else {
      target = JSON.stringify(args);
    }

    const key = `${toolName}:${target.toLowerCase().trim()}`;
    if (!this.distinctExplorations.has(key)) {
      this.distinctExplorations.add(key);
      ExtensionLogger.info(
        `[ExploreBeforeAskGate][${this.generationId}] Recorded distinct exploration: ${key} (${this.distinctExplorations.size}/${this.minExplorationBeforeAsk}).`
      );
    }
  }

  /**
   * Evaluates whether an `ask_user` call is permitted or must be rejected with corrective guidance.
   */
  public evaluateAskUser(question: string): GateEvaluationResult {
    const normalizedQuestion = question.trim().toLowerCase();

    // 1. Escape Hatch: Deadlock Defense (allowed through after 2 rejections in the same task)
    if (this.taskRejectionsCount >= 2) {
      this.clarificationQuestionsAsked++;
      ExtensionLogger.warn(
        `[ExploreBeforeAskGate][${this.generationId}] Escape hatch triggered: task reached 2 rejections. Allowing question through.`
      );
      return {
        allowed: true,
        escapeHatchTriggered: true,
        rejectionCount: this.taskRejectionsCount,
        questionsAskedCount: this.clarificationQuestionsAsked,
      };
    }

    // 2. Escape Hatch: Empty / Irrelevant Workspace
    if (!this.hasRelevantFiles) {
      this.clarificationQuestionsAsked++;
      ExtensionLogger.info(
        `[ExploreBeforeAskGate][${this.generationId}] Workspace discovery found 0 relevant files. Allowing early clarification.`
      );
      return {
        allowed: true,
        escapeHatchTriggered: true,
        rejectionCount: this.taskRejectionsCount,
        questionsAskedCount: this.clarificationQuestionsAsked,
      };
    }

    // 3. Escape Hatch: Model Lacks Tool Support or Consecutive Failures
    if (!this.hasToolSupport || this.consecutiveToolFailures >= 3) {
      this.clarificationQuestionsAsked++;
      ExtensionLogger.warn(
        `[ExploreBeforeAskGate][${this.generationId}] Escape hatch triggered: model lacks tool support or ${this.consecutiveToolFailures} tool failures occurred. Allowing clarification.`
      );
      return {
        allowed: true,
        escapeHatchTriggered: true,
        rejectionCount: this.taskRejectionsCount,
        questionsAskedCount: this.clarificationQuestionsAsked,
      };
    }

    // 4. Clarification Question Budget Limit
    if (this.clarificationQuestionsAsked >= this.maxClarificationQuestionsPerTask) {
      this.taskRejectionsCount++;
      const reason = `Clarification question limit reached (${this.maxClarificationQuestionsPerTask} max per task). Please inspect the workspace and proceed with implementation.`;
      ExtensionLogger.warn(`[ExploreBeforeAskGate][${this.generationId}] Rejected: ${reason}`);
      return {
        allowed: false,
        reason,
        rejectionCount: this.taskRejectionsCount,
        questionsAskedCount: this.clarificationQuestionsAsked,
      };
    }

    // 5. Minimum Exploration Requirement
    if (this.distinctExplorations.size < this.minExplorationBeforeAsk) {
      this.taskRejectionsCount++;
      const remaining = this.minExplorationBeforeAsk - this.distinctExplorations.size;
      const reason = `Inspect the workspace first: use read tools (list_dir, view_file_range, search_workspace) before asking questions. Completed ${this.distinctExplorations.size}/${this.minExplorationBeforeAsk} distinct explorations (${remaining} more required).`;
      ExtensionLogger.warn(`[ExploreBeforeAskGate][${this.generationId}] Rejected: ${reason}`);
      return {
        allowed: false,
        reason,
        rejectionCount: this.taskRejectionsCount,
        questionsAskedCount: this.clarificationQuestionsAsked,
      };
    }

    // 6. Advisory Redundancy Check ("asks about a fact already in discovery data")
    // Rejects at most once per question with explanation, then allows to prevent false-positive stalls.
    if (this.discoveryResult && !this.rejectedFactQuestions.has(normalizedQuestion)) {
      const stacks = this.discoveryResult.detectedStacks;
      const isAskingBackend =
        /what.*backend|which.*backend|backend.*framework|server.*framework/i.test(question);
      const isAskingFrontend =
        /what.*frontend|which.*frontend|frontend.*framework|client.*framework/i.test(question);

      if (isAskingBackend && stacks.some((s) => s.includes('.NET') || s.includes('ASP.NET'))) {
        this.rejectedFactQuestions.add(normalizedQuestion);
        this.taskRejectionsCount++;
        const reason = `The workspace discovery already identified ASP.NET Core (.NET) from project manifests. Please inspect the existing files instead of asking about the backend framework.`;
        ExtensionLogger.warn(`[ExploreBeforeAskGate][${this.generationId}] Advisory Redundancy Rejected: ${reason}`);
        return {
          allowed: false,
          reason,
          isAdvisory: true,
          rejectionCount: this.taskRejectionsCount,
          questionsAskedCount: this.clarificationQuestionsAsked,
        };
      }

      if (isAskingFrontend && stacks.some((s) => s.includes('Angular'))) {
        this.rejectedFactQuestions.add(normalizedQuestion);
        this.taskRejectionsCount++;
        const reason = `The workspace discovery already identified Angular from workspace manifests. Please inspect Frontend.Client files instead of asking about the frontend framework.`;
        ExtensionLogger.warn(`[ExploreBeforeAskGate][${this.generationId}] Advisory Redundancy Rejected: ${reason}`);
        return {
          allowed: false,
          reason,
          isAdvisory: true,
          rejectionCount: this.taskRejectionsCount,
          questionsAskedCount: this.clarificationQuestionsAsked,
        };
      }
    }

    // Passed all checks!
    this.clarificationQuestionsAsked++;
    ExtensionLogger.info(
      `[ExploreBeforeAskGate][${this.generationId}] Approved clarification question (${this.clarificationQuestionsAsked}/${this.maxClarificationQuestionsPerTask}): "${question.slice(0, 50)}..."`
    );
    return {
      allowed: true,
      rejectionCount: this.taskRejectionsCount,
      questionsAskedCount: this.clarificationQuestionsAsked,
    };
  }
}
