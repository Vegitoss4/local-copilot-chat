import { TolerantJsonParser } from './tolerantJsonParser';

export interface PlannedPatch {
  filePath: string;
  target: string;
  replacement: string;
}

export interface ArchitectOutput {
  role: 'architect';
  objective: string;
  architecturePlan: string[];
  filesToModify: string[];
  rationale: string;
}

export interface DeveloperOutput {
  role: 'developer';
  patches: PlannedPatch[];
  createdFiles?: Array<{ filePath: string; content: string }>;
  explanation: string;
}

export interface TesterOutput {
  role: 'tester';
  passed: boolean;
  testCommandsRun: string[];
  failedCount: number;
  failureSummary?: string;
}

export interface ReviewerOutput {
  role: 'reviewer';
  decision: 'APPROVED' | 'REJECTED';
  blockingIssues: string[];
  qualityScore: number; // 0-100
}

export interface SecurityAuditorOutput {
  role: 'security';
  clean: boolean;
  violations: string[];
  threatLevel: 'low' | 'medium' | 'high' | 'critical';
}

export type AnyAgentOutput =
  | ArchitectOutput
  | DeveloperOutput
  | TesterOutput
  | ReviewerOutput
  | SecurityAuditorOutput;

export class TypedAgentContracts {
  /**
   * Validates and parses raw text or JSON into an ArchitectOutput contract.
   */
  public static parseArchitectOutput(raw: string | any): ArchitectOutput {
    const data = this._extractData(raw);
    if (!data || typeof data !== 'object') throw new Error('Architect output must be an object');
    if (!Array.isArray(data.architecturePlan)) throw new Error('Architect output missing array "architecturePlan"');
    if (!Array.isArray(data.filesToModify)) throw new Error('Architect output missing array "filesToModify"');

    return {
      role: 'architect',
      objective: String(data.objective || ''),
      architecturePlan: data.architecturePlan.map(String),
      filesToModify: data.filesToModify.map(String),
      rationale: String(data.rationale || '')
    };
  }

  /**
   * Validates and parses raw text or JSON into a DeveloperOutput contract.
   */
  public static parseDeveloperOutput(raw: string | any): DeveloperOutput {
    const data = this._extractData(raw);
    if (!data || typeof data !== 'object') throw new Error('Developer output must be an object');
    if (!Array.isArray(data.patches)) throw new Error('Developer output missing array "patches"');

    for (const p of data.patches) {
      if (!p.filePath || typeof p.filePath !== 'string') throw new Error('Patch missing string "filePath"');
      if (typeof p.target !== 'string') throw new Error('Patch missing string "target"');
      if (typeof p.replacement !== 'string') throw new Error('Patch missing string "replacement"');
    }

    return {
      role: 'developer',
      patches: data.patches,
      createdFiles: Array.isArray(data.createdFiles) ? data.createdFiles : undefined,
      explanation: String(data.explanation || '')
    };
  }

  /**
   * Validates and parses raw text or JSON into a TesterOutput contract.
   */
  public static parseTesterOutput(raw: string | any): TesterOutput {
    const data = this._extractData(raw);
    if (!data || typeof data !== 'object') throw new Error('Tester output must be an object');
    if (typeof data.passed !== 'boolean') throw new Error('Tester output missing boolean "passed"');

    return {
      role: 'tester',
      passed: Boolean(data.passed),
      testCommandsRun: Array.isArray(data.testCommandsRun) ? data.testCommandsRun.map(String) : [],
      failedCount: typeof data.failedCount === 'number' ? data.failedCount : (data.passed ? 0 : 1),
      failureSummary: data.failureSummary ? String(data.failureSummary) : undefined
    };
  }

  /**
   * Validates and parses raw text or JSON into a ReviewerOutput contract.
   */
  public static parseReviewerOutput(raw: string | any): ReviewerOutput {
    const data = this._extractData(raw);
    if (!data || typeof data !== 'object') throw new Error('Reviewer output must be an object');
    const decision = String(data.decision).toUpperCase();
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new Error(`Invalid reviewer decision: ${data.decision}`);
    }

    return {
      role: 'reviewer',
      decision: decision as 'APPROVED' | 'REJECTED',
      blockingIssues: Array.isArray(data.blockingIssues) ? data.blockingIssues.map(String) : [],
      qualityScore: typeof data.qualityScore === 'number' ? data.qualityScore : (decision === 'APPROVED' ? 90 : 40)
    };
  }

  /**
   * Validates and parses raw text or JSON into a SecurityAuditorOutput contract.
   */
  public static parseSecurityOutput(raw: string | any): SecurityAuditorOutput {
    const data = this._extractData(raw);
    if (!data || typeof data !== 'object') throw new Error('Security output must be an object');
    if (typeof data.clean !== 'boolean') throw new Error('Security output missing boolean "clean"');

    const threat = ['low', 'medium', 'high', 'critical'].includes(data.threatLevel) ? data.threatLevel : (data.clean ? 'low' : 'high');

    return {
      role: 'security',
      clean: Boolean(data.clean),
      violations: Array.isArray(data.violations) ? data.violations.map(String) : [],
      threatLevel: threat
    };
  }

  private static _extractData(raw: string | any): any {
    if (typeof raw === 'string') {
      const res = TolerantJsonParser.parse(raw);
      if (!res.success) {
        throw new Error(`Failed to parse agent JSON payload: ${res.error}`);
      }
      return res.data;
    }
    return raw;
  }
}
