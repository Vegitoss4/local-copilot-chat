import * as vscode from 'vscode';
import * as path from 'path';
import { CommandClassifier, CommandTier } from './commandClassifier';
import { PathSecurity } from './pathSecurity';
import { ApprovalRequest } from './autonomousAgent';

/**
 * Deliverable 11.6: Unified Approval Policy Engine & Grant Storage
 * Consolidates command tiers, file sensitivity, workspace trust, and
 * granular auto-approval grants with TTL expiration into a single policy gate.
 */

export type ApprovalDecision = 'allow' | 'prompt' | 'deny';
export type GrantScope = 'once' | 'session' | 'workspace';

export interface PolicyGrant {
  id: string;
  pattern: string; // e.g. "tool:writeFile:src/**" or "cmd:npm test"
  scope: GrantScope;
  grantedAt: number;
  expiresAt: number; // timestamp in ms
}

export interface PolicyEvaluationResult {
  decision: ApprovalDecision;
  reason: string;
  matchedGrant?: PolicyGrant;
  riskLevel: 'low' | 'medium' | 'high' | 'prohibited';
}

export class ApprovalPolicyEngine {
  private static _instance: ApprovalPolicyEngine | undefined;

  // In-memory active grants with TTL
  private _grants: Map<string, PolicyGrant> = new Map();
  public static readonly DEFAULT_SESSION_GRANT_TTL_MS = 60 * 60 * 1000; // 1 hour

  public static getInstance(): ApprovalPolicyEngine {
    if (!this._instance) {
      this._instance = new ApprovalPolicyEngine();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  /**
   * Evaluates an action against safety rules, workspace trust, sensitive targets, and grants.
   */
  public evaluate(
    action: {
      toolName: string;
      targetPath?: string;
      command?: string;
      isAutonomousMode?: boolean;
    },
    workspaceRootUri?: vscode.Uri
  ): PolicyEvaluationResult {
    const isAutonomous = action.isAutonomousMode ?? true;

    // 1. Untrusted workspace gate: complete denial for shell executions
    if (vscode.workspace.isTrusted === false) {
      if (action.toolName === 'executeCommand' || action.toolName === 'runTerminalCommand' || action.command) {
        return {
          decision: 'deny',
          reason: 'Command execution is strictly prohibited in Untrusted Workspaces.',
          riskLevel: 'prohibited'
        };
      }
    }

    // 2. Command tier analysis
    if (action.command) {
      let classification;
      try {
        classification = CommandClassifier.classify(action.command);
      } catch (err: any) {
        return {
          decision: 'deny',
          reason: `Unsafe command syntax or shell metacharacter rejected: ${err.message}`,
          riskLevel: 'prohibited'
        };
      }

      // Prohibited commands (Tier 4): never allowed or grantable
      if (classification.tier === CommandTier.TIER_4_PROHIBITED) {
        return {
          decision: 'deny',
          reason: `Prohibited command: ${classification.reason}`,
          riskLevel: 'prohibited'
        };
      }

      // Read-only inspection commands (Tier 1): allow in autonomous mode
      if (classification.tier === CommandTier.TIER_1_SAFE_READONLY) {
        return {
          decision: isAutonomous ? 'allow' : 'prompt',
          reason: 'Read-only inspection command',
          riskLevel: 'low'
        };
      }

      // Project execution (Tier 2) & Arbitrary (Tier 3)
      const grantKey = `cmd:${action.command.trim()}`;
      const activeGrant = this._findActiveGrant(grantKey);
      if (activeGrant) {
        return {
          decision: 'allow',
          reason: `Authorized by active grant: ${activeGrant.pattern}`,
          matchedGrant: activeGrant,
          riskLevel: classification.tier === CommandTier.TIER_2_PROJECT_EXECUTION ? 'medium' : 'high'
        };
      }

      return {
        decision: 'prompt',
        reason: `Command execution requires explicit approval (${classification.tier}): ${action.command.slice(0, 80)}`,
        riskLevel: classification.tier === CommandTier.TIER_2_PROJECT_EXECUTION ? 'medium' : 'high'
      };
    }

    // 3. Sensitive file path defense
    if (action.targetPath) {
      const isSensitive = PathSecurity.isSensitiveTarget(action.targetPath);
      if (isSensitive) {
        // Sensitive files (.env, .git, etc.) ALWAYS require explicit prompt, never auto-granted
        return {
          decision: 'prompt',
          reason: `Access to sensitive target requires explicit approval: ${action.targetPath}`,
          riskLevel: 'high'
        };
      }
    }

    // 4. Tool-level risk classification
    const readOnlyTools = new Set(['readFile', 'listFiles', 'searchWorkspace', 'getWorkspaceSummary', 'getGitDiff', 'checkBuild', 'getDiagnostics']);
    if (readOnlyTools.has(action.toolName)) {
      return {
        decision: 'allow',
        reason: 'Read-only inspection tool',
        riskLevel: 'low'
      };
    }

    // Check grants for tool actions
    const toolGrantKey = action.targetPath
      ? `tool:${action.toolName}:${action.targetPath.replace(/\\/g, '/')}`
      : `tool:${action.toolName}`;

    const activeGrant = this._findActiveGrant(toolGrantKey);
    if (activeGrant) {
      return {
        decision: 'allow',
        reason: `Authorized by active grant: ${activeGrant.pattern}`,
        matchedGrant: activeGrant,
        riskLevel: 'medium'
      };
    }

    // In autonomous mode: standard modification tools are allowed if non-sensitive
    if (isAutonomous) {
      return {
        decision: 'allow',
        reason: 'Autonomous mode authorized for non-sensitive tool operation',
        riskLevel: 'medium'
      };
    }

    // Non-autonomous: prompt for all modifications
    return {
      decision: 'prompt',
      reason: `Non-autonomous mode requires confirmation for: ${action.toolName}`,
      riskLevel: 'medium'
    };
  }

  /**
   * Registers a security grant with TTL.
   */
  public addGrant(
    pattern: string,
    scope: GrantScope = 'session',
    ttlMs: number = ApprovalPolicyEngine.DEFAULT_SESSION_GRANT_TTL_MS
  ): PolicyGrant {
    const now = Date.now();
    const grant: PolicyGrant = {
      id: `grant_${now}_${Math.random().toString(36).substring(2, 7)}`,
      pattern: pattern.trim(),
      scope,
      grantedAt: now,
      expiresAt: now + ttlMs
    };

    this._grants.set(grant.pattern, grant);
    return grant;
  }

  /**
   * Revokes all active grants.
   */
  public revokeAllGrants(): void {
    this._grants.clear();
  }

  /**
   * Revokes a specific grant by pattern.
   */
  public revokeGrant(pattern: string): boolean {
    return this._grants.delete(pattern.trim());
  }

  public getActiveGrants(): PolicyGrant[] {
    const now = Date.now();
    const active: PolicyGrant[] = [];
    for (const [key, grant] of this._grants.entries()) {
      if (grant.expiresAt > now) {
        active.push(grant);
      } else {
        this._grants.delete(key);
      }
    }
    return active;
  }

  private _findActiveGrant(targetKey: string): PolicyGrant | undefined {
    const now = Date.now();
    for (const [pattern, grant] of this._grants.entries()) {
      if (grant.expiresAt <= now) {
        this._grants.delete(pattern);
        continue;
      }

      // Exact match or wildcard pattern match
      if (pattern === targetKey) {
        return grant;
      }
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (targetKey.startsWith(prefix)) {
          return grant;
        }
      }
    }
    return undefined;
  }
}
