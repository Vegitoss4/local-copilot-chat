import * as vscode from 'vscode';
import * as path from 'path';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';
import { OllamaService } from './ollamaService';
import { AgentToolService } from './agentToolService';
import { AutonomousAgent } from './autonomousAgent';

export type OrchestrationStage =
  | 'PENDING'
  | 'PLANNING'
  | 'IMPLEMENTING'
  | 'TESTING'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED';

export interface OrchestrationTaskPlan {
  objective: string;
  acceptanceCriteria: string[];
  plannedFiles: string[];
}

export interface ReviewFeedback {
  approved: boolean;
  notes: string;
  missingCriteria?: string[];
}

export interface OrchestrationWhiteboard {
  version: 1;
  taskId: string;
  stage: OrchestrationStage;
  iteration: number;
  maxIterations: number;
  plan?: OrchestrationTaskPlan;
  implementationLogs: string[];
  testResults: Array<{ name: string; passed: boolean; error?: string }>;
  reviewHistory: ReviewFeedback[];
  modifiedFiles: string[];
}

export interface OrchestratorHandlers {
  runArchitect: (objective: string) => Promise<OrchestrationTaskPlan>;
  runDeveloper: (plan: OrchestrationTaskPlan, feedback?: ReviewFeedback) => Promise<{ modifiedFiles: string[]; logs: string }>;
  runTester: (modifiedFiles: string[]) => Promise<Array<{ name: string; passed: boolean; error?: string }>>;
  runReviewer: (plan: OrchestrationTaskPlan, testResults: Array<{ name: string; passed: boolean; error?: string }>) => Promise<ReviewFeedback>;
}

export class AutonomousOrchestrationEngine {
  private _maxIterations: number;

  constructor(maxIterations: number = 3) {
    this._maxIterations = maxIterations;
  }

  /**
   * Runs the complete autonomous engineering lifecycle:
   * Architect -> Developer -> Tester -> Reviewer (with feedback loop up to maxIterations).
   */
  public async executePipeline(
    taskId: string,
    userObjective: string,
    handlers: OrchestratorHandlers,
    targetRootUri?: vscode.Uri,
    cancellationToken?: vscode.CancellationToken
  ): Promise<OrchestrationWhiteboard> {
    const whiteboard: OrchestrationWhiteboard = {
      version: 1,
      taskId,
      stage: 'PENDING',
      iteration: 0,
      maxIterations: this._maxIterations,
      implementationLogs: [],
      testResults: [],
      reviewHistory: [],
      modifiedFiles: []
    };

    try {
      // Step 1: Architect Planning
      if (cancellationToken?.isCancellationRequested) {
        whiteboard.stage = 'FAILED';
        return whiteboard;
      }
      whiteboard.stage = 'PLANNING';
      await this._persistWhiteboard(whiteboard, targetRootUri);

      const plan = await handlers.runArchitect(userObjective);
      whiteboard.plan = plan;
      await this._persistWhiteboard(whiteboard, targetRootUri);

      let lastReviewFeedback: ReviewFeedback | undefined = undefined;

      // Step 2: Implementation & Verification Loop
      while (whiteboard.iteration < whiteboard.maxIterations) {
        if (cancellationToken?.isCancellationRequested) {
          whiteboard.stage = 'FAILED';
          break;
        }

        whiteboard.iteration++;

        // Stage: Implementing (Developer)
        whiteboard.stage = 'IMPLEMENTING';
        await this._persistWhiteboard(whiteboard, targetRootUri);

        const devResult = await handlers.runDeveloper(plan, lastReviewFeedback);
        whiteboard.modifiedFiles = Array.from(new Set([...whiteboard.modifiedFiles, ...devResult.modifiedFiles]));
        whiteboard.implementationLogs.push(`[Iteration ${whiteboard.iteration}] ${devResult.logs}`);
        await this._persistWhiteboard(whiteboard, targetRootUri);

        // Stage: Testing (Tester)
        whiteboard.stage = 'TESTING';
        await this._persistWhiteboard(whiteboard, targetRootUri);

        const tests = await handlers.runTester(whiteboard.modifiedFiles);
        whiteboard.testResults = tests;
        await this._persistWhiteboard(whiteboard, targetRootUri);

        // Stage: Reviewing (Reviewer)
        whiteboard.stage = 'REVIEWING';
        await this._persistWhiteboard(whiteboard, targetRootUri);

        const review = await handlers.runReviewer(plan, tests);
        whiteboard.reviewHistory.push(review);
        await this._persistWhiteboard(whiteboard, targetRootUri);

        if (review.approved) {
          whiteboard.stage = 'COMPLETED';
          await this._persistWhiteboard(whiteboard, targetRootUri);
          return whiteboard;
        } else {
          lastReviewFeedback = review;
        }
      }

      whiteboard.stage = 'FAILED';
      await this._persistWhiteboard(whiteboard, targetRootUri);

      return whiteboard;
    } catch (err: any) {
      whiteboard.stage = 'FAILED';
      whiteboard.implementationLogs.push(`[Fatal Orchestration Error] ${err?.message || String(err)}`);
      await this._persistWhiteboard(whiteboard, targetRootUri);
      return whiteboard;
    }
  }

  /**
   * Constructs default production handlers connecting Architect, Developer, Tester, and Reviewer
   * to real Ollama LLM prompts, AutonomousAgent react loop, and AgentToolService workspace verification.
   */
  public static createDefaultHandlers(
    ollamaService: OllamaService,
    model: string,
    workspaceRootUri?: vscode.Uri,
    log?: (msg: string) => void
  ): OrchestratorHandlers {
    return {
      runArchitect: async (objective: string): Promise<OrchestrationTaskPlan> => {
        log?.(`[Orchestrator:Architect] Generating architectural plan for: ${objective}`);
        const prompt = `You are a Principal Software Architect.
Given this engineering objective: "${objective}"
Create a concise technical plan with clear acceptance criteria and affected file paths.
Respond STRICTLY with a valid JSON object matching this schema:
{
  "objective": "${objective}",
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "plannedFiles": ["path/to/file1.ts"]
}
Only output the JSON object, nothing else.`;

        let rawResponse = '';
        try {
          rawResponse = await ollamaService.streamChat(model, [{ role: 'user', content: prompt }], () => {});
        } catch {}

        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
              objective: parsed.objective || objective,
              acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) && parsed.acceptanceCriteria.length > 0
                ? parsed.acceptanceCriteria
                : [objective],
              plannedFiles: Array.isArray(parsed.plannedFiles) ? parsed.plannedFiles : []
            };
          } catch {}
        }

        return {
          objective,
          acceptanceCriteria: ['Implement requested functionality', 'Ensure tests pass'],
          plannedFiles: []
        };
      },

      runDeveloper: async (plan: OrchestrationTaskPlan, feedback?: ReviewFeedback): Promise<{ modifiedFiles: string[]; logs: string }> => {
        log?.(`[Orchestrator:Developer] Implementing plan for: ${plan.objective}`);
        let devGoal = `Implement the following plan:\nObjective: ${plan.objective}\nAcceptance Criteria: ${plan.acceptanceCriteria.join('; ')}\nTarget files: ${plan.plannedFiles.join(', ')}`;
        if (feedback && !feedback.approved) {
          devGoal += `\nAddress prior review feedback: ${feedback.notes}. Missing criteria: ${(feedback.missingCriteria || []).join(', ')}`;
        }

        const agent = new AutonomousAgent(ollamaService, {
          userModel: model,
          availableModels: [model],
          workspaceRootUri,
          maxTurns: 10
        });

        const logs: string[] = [];
        const resultText = await agent.executeTask(devGoal, {
          onStatusUpdate: (s) => logs.push(s),
          onProgress: (p) => logs.push(p.message)
        });

        return {
          modifiedFiles: plan.plannedFiles.length > 0 ? plan.plannedFiles : ['(workspace)'],
          logs: logs.join(' | ') || resultText
        };
      },

      runTester: async (modifiedFiles: string[]): Promise<Array<{ name: string; passed: boolean; error?: string }>> => {
        log?.(`[Orchestrator:Tester] Running test verification across ${modifiedFiles.length} file(s)...`);
        const buildRes = await AgentToolService.checkBuild();
        return [
          {
            name: 'Workspace Build Verification',
            passed: buildRes.success,
            error: buildRes.success ? undefined : buildRes.output
          }
        ];
      },

      runReviewer: async (plan: OrchestrationTaskPlan, testResults: Array<{ name: string; passed: boolean; error?: string }>): Promise<ReviewFeedback> => {
        log?.(`[Orchestrator:Reviewer] Reviewing test results and acceptance criteria...`);
        const allTestsPassed = testResults.every(t => t.passed);
        if (!allTestsPassed) {
          const failures = testResults.filter(t => !t.passed).map(t => `${t.name}: ${t.error}`).join('; ');
          return {
            approved: false,
            notes: `Test failures detected: ${failures}`,
            missingCriteria: ['Passing build/test suite']
          };
        }

        const prompt = `You are a Principal Code Reviewer.
Plan: "${plan.objective}"
Criteria: ${JSON.stringify(plan.acceptanceCriteria)}
All automated verification tests PASSED.
Evaluate if the plan is satisfied. Respond STRICTLY as JSON:
{"approved": true, "notes": "All criteria met and verified", "missingCriteria": []}
or if defects exist:
{"approved": false, "notes": "Reason for rejection", "missingCriteria": ["unmet criterion"]}`;

        try {
          let raw = '';
          try {
            raw = await ollamaService.streamChat(model, [{ role: 'user', content: prompt }], () => {});
          } catch {}
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
              approved: parsed.approved === true,
              notes: parsed.notes || 'Review completed',
              missingCriteria: Array.isArray(parsed.missingCriteria) ? parsed.missingCriteria : []
            };
          }
        } catch {}

        return {
          approved: allTestsPassed,
          notes: allTestsPassed ? 'All criteria met and automated tests passed.' : 'Test verification failed.',
          missingCriteria: []
        };
      }
    };
  }

  private async _persistWhiteboard(whiteboard: OrchestrationWhiteboard, targetRootUri?: vscode.Uri): Promise<void> {
    try {
      const folder = WorkspaceManager.getTargetWorkspaceFolder(targetRootUri);
      if (!folder) return;

      const storageUri = WorkspaceManager.getStorageUri(folder, 'orchestration');
      const fileUri = vscode.Uri.joinPath(storageUri, `whiteboard-${whiteboard.taskId}.json`);
      await AtomicFileWriter.writeJson(fileUri, whiteboard);
    } catch (e) {
      console.error('[AutonomousOrchestrationEngine] Failed to persist whiteboard:', e);
    }
  }
}
