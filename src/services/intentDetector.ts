/**
 * Deterministic Intent Detection Engine for Local Copilot Chat.
 * Accurately classifies whether a user prompt has file-editing intent
 * without making external model calls, avoiding false positives on questions.
 */

export interface IntentDetectionResult {
  hasEditIntent: boolean;
  reason?: string;
  trigger?: string;
  isReferential?: boolean;
}

const QUESTION_PREFIXES = [
  'how do i',
  'how can i',
  'how to',
  'how would i',
  'why is',
  'why does',
  'why did',
  'what is',
  'what does',
  'what are',
  'explain',
  'explain to me',
  'tell me about',
  'show me how',
  'can you explain',
  'could you explain',
  'what would happen',
];

const DIRECT_EDIT_PATTERNS = [
  /\b(implement|scaffold|scaffolding)\b/i,
  /\b(fix\s+(?:the|this|these|it|all|them|bug|bugs|issue|issues|error|errors|code))\b/i,
  /\b(create|add|generate|write)\s+(?:a\s+|the\s+|new\s+|an\s+)*(?:[a-zA-Z0-9_\-\.]+\s+)*(?:file|files|class|controller|component|service|endpoint|model|repo|folder|scaffold|app)\b/i,
  /\b(update|modify|edit|patch|change)\s+(?:the\s+)?(?:file|files|code|codebase|repo|project|solution)\b/i,
  /\b(refactor|rewrite|rework)\s+(?:the\s+)?(?:file|files|code|class|controller|function|method)\b/i,
  /\bwrite\s+(?:the\s+)?(?:code|implementation)\s+(?:for|to|in)\b/i,
];

const REFERENTIAL_PATTERNS = [
  /^(?:please\s+)?(?:do\s+it|do\s+those|do\s+that|do\s+them|implement\s+(?:it|those|these|them)|fix\s+(?:it|them|this|those)|apply\s+(?:it|them|those|these|changes|the\s+changes)|make\s+(?:it|those|these)\s+changes?)\.?$/i,
];

export class IntentDetector {
  /**
   * Deterministically evaluates if a user message intends to modify or write workspace files.
   */
  public static detectEditIntent(
    prompt: string,
    lastAssistantTurn?: string
  ): IntentDetectionResult {
    if (!prompt || !prompt.trim()) {
      return { hasEditIntent: false, reason: 'Empty prompt' };
    }

    const trimmed = prompt.trim();
    const lower = trimmed.toLowerCase();

    // 1. Anti-False-Positive Filter: Pure informational questions
    const isQuestion = lower.endsWith('?') || QUESTION_PREFIXES.some((prefix) => lower.startsWith(prefix));
    if (isQuestion) {
      // Check if it's strictly a question like "how do I fix this?" or "explain this function"
      const startsWithQuestion = QUESTION_PREFIXES.some((prefix) => lower.startsWith(prefix));
      if (startsWithQuestion) {
        return {
          hasEditIntent: false,
          reason: 'Suppressed: Informational or explanatory question',
        };
      }
    }

    // 2. Referential action commands (e.g. "fix it", "do it", "implement those")
    for (const pattern of REFERENTIAL_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) {
        // Inspect the previous assistant turn in chat history
        if (lastAssistantTurn && lastAssistantTurn.trim()) {
          const hasCodeFence = /```[a-zA-Z0-9_\-]*\n[\s\S]*?```/.test(lastAssistantTurn);
          const hasActionableGuidance = /\b(step\s+\d+|missing pieces|to make (?:this|the) project|create|scaffold|update)\b/i.test(
            lastAssistantTurn
          );

          if (hasCodeFence || hasActionableGuidance) {
            return {
              hasEditIntent: true,
              reason: `Referential edit command "${match[0]}" refers to preceding recommendations/code in conversation history`,
              trigger: match[0],
              isReferential: true,
            };
          }
        }
        // If no prior assistant turn with actionable content, still flag referential command
        return {
          hasEditIntent: true,
          reason: `Referential action trigger "${match[0]}"`,
          trigger: match[0],
          isReferential: true,
        };
      }
    }

    // 3. Direct action patterns
    for (const pattern of DIRECT_EDIT_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) {
        return {
          hasEditIntent: true,
          reason: `Action verb pattern matched: "${match[0]}"`,
          trigger: match[0],
          isReferential: false,
        };
      }
    }

    // Default: conversational / general chat
    return {
      hasEditIntent: false,
      reason: 'No editing trigger detected',
    };
  }
}
