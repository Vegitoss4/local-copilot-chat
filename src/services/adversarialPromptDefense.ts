export interface SanitizedFeedResult {
  sanitizedText: string;
  injectionDetected: boolean;
  detectedSignatures: string[];
}

export class AdversarialPromptDefense {
  private static readonly INJECTION_SIGNATURES: Array<{ name: string; pattern: RegExp }> = [
    {
      name: 'INSTRUCTION_OVERRIDE',
      pattern: /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|directives|prompts)/i
    },
    {
      name: 'ROLE_SPOOFING',
      pattern: /^(?:\s*<\/?(?:system|developer|admin|root|user|assistant)>|\[(?:SYSTEM|DEVELOPER|ADMIN)\])/im
    },
    {
      name: 'SAFETY_BYPASS',
      pattern: /(?:bypass|disable|turn off|skip)\s+(?:safety|security|approval|sandbox|guardrails)/i
    },
    {
      name: 'JAILBREAK_MARKER',
      pattern: /(?:DAN mode|developer mode enabled|unrestricted mode|jailbreak active)/i
    },
    {
      name: 'SECRET_EXFILTRATION',
      pattern: /(?:print|dump|leak|exfiltrate|send|post)\s+(?:api[_-]?keys?|secrets?|tokens?|passwords?|\.env)/i
    }
  ];

  /**
   * Sanitizes subagent output or tool text before feeding it into another agent's prompt context.
   */
  public static sanitizeFeed(rawText: string, originAgent: string): SanitizedFeedResult {
    if (!rawText || typeof rawText !== 'string') {
      return { sanitizedText: '', injectionDetected: false, detectedSignatures: [] };
    }

    const detectedSignatures: string[] = [];

    for (const sig of this.INJECTION_SIGNATURES) {
      if (sig.pattern.test(rawText)) {
        detectedSignatures.push(sig.name);
      }
    }

    // Neutralize role spoofing tags
    let sanitized = rawText
      .replace(/<(\/?(?:system|developer|admin|root|user|assistant))>/gi, '&lt;$1&gt;')
      .replace(/\[(SYSTEM|DEVELOPER|ADMIN)\]/gi, '[$1_DATA]');

    // Neutralize instruction override phrases by prefixing with [QUOTED_DATA]:
    for (const sig of this.INJECTION_SIGNATURES) {
      sanitized = sanitized.replace(sig.pattern, match => `[NEUTRALIZED_UNTRUSTED_INSTRUCTION: ${match}]`);
    }

    // Wrap in non-privileged data container
    const safeAgent = originAgent.replace(/[^a-zA-Z0-9_-]/g, '');
    const wrapped = `<agent_data_feed agent="${safeAgent}">\n${sanitized.trim()}\n</agent_data_feed>`;

    return {
      sanitizedText: wrapped,
      injectionDetected: detectedSignatures.length > 0,
      detectedSignatures
    };
  }
}
