import { TolerantJsonParser } from './tolerantJsonParser';

/**
 * Deliverable 9.3: Versioned Plan Schema, Validation & Fast-Path Routing.
 */

export interface PlanStepV1 {
  id: string;
  description: string;
  tool: string;
  args: Record<string, any>;
  dependsOn: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

export interface PlanSchemaV1 {
  schemaVersion: 1;
  objective: string;
  targetFiles?: string[];
  steps: PlanStepV1[];
}

export interface PlanValidationResult {
  valid: boolean;
  plan?: PlanSchemaV1;
  errors: string[];
}

export class PlanManager {
  public static readonly ALLOWED_TOOLS = new Set([
    'readFile',
    'createFile',
    'patchFile',
    'runCommand',
    'findCallers',
    'searchSymbols',
    'listDir',
    'diagnoseError'
  ]);

  public static readonly MAX_STEPS = 10;

  /**
   * Fast-path router: Determines if user query is a trivial question or simple lookup
   * that can bypass multi-step autonomous planning.
   */
  public static isTrivialQuery(userText: string): boolean {
    const text = userText.trim().toLowerCase();

    // Pure conversational greetings or short questions
    if (/^(hi|hello|hey|help|who are you|what can you do)[\s?!.]*$/i.test(text)) {
      return true;
    }

    // Explanation or syntax queries with no action keywords
    const isExplanation = /^(how do i|how to|what is|explain|why does|difference between|syntax for)/i.test(text);
    const hasActionWords = /(create|refactor|fix|repair|build|generate|delete|implement|patch|install)/i.test(text);

    if (isExplanation && !hasActionWords) {
      return true;
    }

    // Very short queries (< 25 chars) without action verbs
    if (text.length < 25 && !hasActionWords) {
      return true;
    }

    return false;
  }

  /**
   * Validates a parsed or raw JSON plan against PlanSchemaV1 rules.
   */
  public static validatePlan(raw: string | any): PlanValidationResult {
    const errors: string[] = [];

    let parsed = raw;
    if (typeof raw === 'string') {
      const tolerantRes = TolerantJsonParser.parse<PlanSchemaV1>(raw);
      if (!tolerantRes.success || !tolerantRes.data) {
        return {
          valid: false,
          errors: [`Failed to parse JSON plan: ${tolerantRes.error || 'Invalid syntax'}`]
        };
      }
      parsed = tolerantRes.data;
    }

    if (!parsed || typeof parsed !== 'object') {
      return { valid: false, errors: ['Plan root must be an object'] };
    }

    if (parsed.schemaVersion !== 1) {
      errors.push(`Invalid schemaVersion: expected 1, got ${parsed.schemaVersion}`);
    }

    if (!parsed.objective || typeof parsed.objective !== 'string') {
      errors.push('Plan must have a non-empty string "objective"');
    }

    if (!Array.isArray(parsed.steps)) {
      errors.push('Plan "steps" must be an array');
      return { valid: false, errors };
    }

    if (parsed.steps.length === 0) {
      errors.push('Plan "steps" cannot be empty');
    }

    if (parsed.steps.length > PlanManager.MAX_STEPS) {
      errors.push(`Plan exceeds maximum allowable step limit (${PlanManager.MAX_STEPS} steps, got ${parsed.steps.length})`);
    }

    const seenStepIds = new Set<string>();

    for (let i = 0; i < parsed.steps.length; i++) {
      const step = parsed.steps[i];
      if (!step || typeof step !== 'object') {
        errors.push(`Step at index ${i} is not a valid object`);
        continue;
      }

      if (!step.id || typeof step.id !== 'string') {
        errors.push(`Step at index ${i} missing valid string "id"`);
      } else {
        if (seenStepIds.has(step.id)) {
          errors.push(`Duplicate step ID "${step.id}"`);
        }
        seenStepIds.add(step.id);
      }

      if (!step.description || typeof step.description !== 'string') {
        errors.push(`Step "${step.id || i}" missing string "description"`);
      }

      if (!step.tool || typeof step.tool !== 'string') {
        errors.push(`Step "${step.id || i}" missing string "tool"`);
      } else if (!PlanManager.ALLOWED_TOOLS.has(step.tool)) {
        errors.push(`Step "${step.id || i}" specifies unknown tool "${step.tool}"`);
      }

      if (!step.args || typeof step.args !== 'object') {
        errors.push(`Step "${step.id || i}" args must be an object`);
      }

      if (!Array.isArray(step.dependsOn)) {
        errors.push(`Step "${step.id || i}" dependsOn must be an array`);
      } else {
        // Enforce acyclic and backward-only dependencies
        for (const depId of step.dependsOn) {
          if (!seenStepIds.has(depId) || depId === step.id) {
            errors.push(`Step "${step.id}" has invalid or forward dependency on "${depId}"`);
          }
        }
      }

      // Default status to pending if unset
      if (!step.status) {
        step.status = 'pending';
      }
    }

    return {
      valid: errors.length === 0,
      plan: errors.length === 0 ? (parsed as PlanSchemaV1) : undefined,
      errors
    };
  }
}
