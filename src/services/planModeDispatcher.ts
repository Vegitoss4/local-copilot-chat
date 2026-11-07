import * as vscode from 'vscode';
import { ToolCall, ToolResult } from './agentToolService';

/**
 * Deliverable 11.4: Read-Only Plan Mode & Strict Dispatcher Enforcement
 * Enforces strict read-only execution boundaries during Plan Mode,
 * stripping destructive tools from registry and failing closed if a model
 * attempts write or shell operations.
 */

export class PlanModeViolationError extends Error {
  constructor(toolName: string) {
    super(
      `Tool execution prohibited in Plan Mode: "${toolName}". ` +
      `Plan mode is strictly read-only. Switch to Agent mode (/mode agent) to authorize modifications.`
    );
    this.name = 'PlanModeViolationError';
  }
}

export interface StructuredPlan {
  planTitle: string;
  goal: string;
  affectedFiles: string[];
  architecturalStrategy: string;
  stepByStepPlan: Array<{
    stepNumber: number;
    description: string;
    expectedOutcome: string;
  }>;
  verificationStrategy: string;
  rollbackStrategy: string;
}

export class PlanModeDispatcher {
  /**
   * Set of strictly read-only tools permitted during Plan Mode.
   */
  public static readonly READ_ONLY_TOOL_WHITELIST = new Set<string>([
    'readFile',
    'listFiles',
    'searchWorkspace',
    'getWorkspaceSummary',
    'getGitDiff',
    'checkBuild',
    'getDiagnostics'
  ]);

  /**
   * Verifies whether a given tool is permitted in Plan Mode.
   */
  public static isToolPermitted(toolName: string): boolean {
    if (!toolName) return false;
    return this.READ_ONLY_TOOL_WHITELIST.has(toolName);
  }

  /**
   * Filters an array of tool definitions to only retain read-only tools.
   */
  public static filterAllowedTools<T extends { function?: { name: string }; name?: string }>(
    tools: T[]
  ): T[] {
    return tools.filter(tool => {
      const name = tool.function?.name || tool.name || '';
      return this.isToolPermitted(name);
    });
  }

  /**
   * Intercepts a tool call in Plan Mode.
   * If permitted, allows execution; if prohibited, rejects with PlanModeViolationError.
   */
  public static interceptToolCall(
    call: ToolCall
  ): { permitted: boolean; errorResult?: ToolResult } {
    const toolName = call.function?.name || 'unknown';

    if (!this.isToolPermitted(toolName)) {
      return {
        permitted: false,
        errorResult: {
          toolCallId: call.id,
          name: toolName,
          success: false,
          output: `[PLAN MODE ENFORCEMENT] Execution of tool "${toolName}" is prohibited in Plan Mode. Plan Mode is strictly read-only. Provide architectural analysis, diff proposals, and step-by-step instructions without executing modifications.`
        }
      };
    }

    return { permitted: true };
  }

  /**
   * Validates and parses a structured plan JSON from model output.
   */
  public static parseStructuredPlan(text: string): StructuredPlan | null {
    if (!text) return null;

    try {
      // Look for JSON block in markdown fences or raw JSON
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
      const rawJson = jsonMatch[1] || text;
      const parsed = JSON.parse(rawJson.trim());

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.planTitle === 'string' &&
        typeof parsed.goal === 'string' &&
        Array.isArray(parsed.stepByStepPlan)
      ) {
        return {
          planTitle: parsed.planTitle,
          goal: parsed.goal,
          affectedFiles: Array.isArray(parsed.affectedFiles) ? parsed.affectedFiles : [],
          architecturalStrategy: parsed.architecturalStrategy || '',
          stepByStepPlan: parsed.stepByStepPlan.map((s: any, idx: number) => ({
            stepNumber: s.stepNumber || idx + 1,
            description: s.description || String(s),
            expectedOutcome: s.expectedOutcome || ''
          })),
          verificationStrategy: parsed.verificationStrategy || '',
          rollbackStrategy: parsed.rollbackStrategy || ''
        };
      }
    } catch {}

    return null;
  }
}
