/**
 * Deliverable 9.2: Dynamic Context Budget Manager & Token Conservation.
 * Allocates strict token ceilings across context categories for 8k Ollama models,
 * enforces hard truncations, and applies XML quarantine around untrusted workspace code chunks.
 */

export interface ContextCategoryBudget {
  systemAndTools: number;
  repoMap: number;
  planAndTask: number;
  codeChunks: number;
  reservedOutput: number;
}

export interface ContextChunk {
  source: string;
  content: string;
  priority?: number; // Higher number = higher priority
  lineRange?: { start: number; end: number };
}

export interface ContextBudgetReport {
  totalBudgetTokens: number;
  allocatedTokens: ContextCategoryBudget;
  usedTokens: {
    systemAndTools: number;
    repoMap: number;
    planAndTask: number;
    codeChunks: number;
    totalPrompt: number;
    availableForOutput: number;
  };
  truncatedChunksCount: number;
  quarantinedChunksCount: number;
}

export class ContextBudgetManager {
  public static readonly DEFAULT_TOTAL_BUDGET = 8192;

  private _totalBudget: number;
  private _budgets: ContextCategoryBudget;
  private _truncatedCount: number = 0;
  private _quarantinedCount: number = 0;

  constructor(totalBudget: number = ContextBudgetManager.DEFAULT_TOTAL_BUDGET) {
    this._totalBudget = totalBudget;
    // Default allocations calibrated for 8k window
    this._budgets = {
      systemAndTools: Math.floor(totalBudget * 0.20), // ~1638 tokens
      repoMap: Math.floor(totalBudget * 0.12),        // ~983 tokens
      planAndTask: Math.floor(totalBudget * 0.10),    // ~819 tokens
      codeChunks: Math.floor(totalBudget * 0.38),     // ~3112 tokens
      reservedOutput: Math.floor(totalBudget * 0.20)  // ~1638 tokens
    };
  }

  public getBudgets(): Readonly<ContextCategoryBudget> {
    return { ...this._budgets };
  }

  /**
   * Estimates token count (approx 4 chars per token).
   */
  public estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Quarantines untrusted workspace code snippets or tool output in a secured XML wrapper.
   * Strips or neutralizes nested prompt injection tags.
   */
  public quarantineChunk(chunk: ContextChunk): string {
    this._quarantinedCount++;
    const safeSource = chunk.source.replace(/[<>"]/g, '');
    const rangeAttr = chunk.lineRange ? ` lines="${chunk.lineRange.start}-${chunk.lineRange.end}"` : '';

    // Neutralize any deceptive injection attempts inside the raw content
    const sanitizedContent = chunk.content
      .replace(/<\/untrusted_content>/gi, '&lt;/untrusted_content&gt;')
      .replace(/<system>/gi, '&lt;system&gt;')
      .replace(/<\/system>/gi, '&lt;/system&gt;');

    return `<untrusted_content source="${safeSource}"${rangeAttr}>\n${sanitizedContent}\n</untrusted_content>`;
  }

  /**
   * Truncates a string to stay strictly within a maximum token limit.
   */
  public truncateToTokenLimit(text: string, maxTokens: number): string {
    const estimated = this.estimateTokens(text);
    if (estimated <= maxTokens) {
      return text;
    }

    this._truncatedCount++;
    const maxChars = maxTokens * 4;
    const truncatedText = text.substring(0, Math.max(0, maxChars - 60));
    return `${truncatedText}\n... [Content truncated to fit ${maxTokens} token budget]`;
  }

  /**
   * Packs prioritized context chunks into the codeChunks budget ceiling.
   */
  public packCodeChunks(chunks: ContextChunk[]): { packedText: string; includedSources: string[]; report: ContextBudgetReport } {
    // Sort chunks by priority descending
    const sorted = [...chunks].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const maxTokens = this._budgets.codeChunks;

    const packedSnippets: string[] = [];
    const includedSources: string[] = [];
    let currentTokens = 0;

    for (const chunk of sorted) {
      const quarantined = this.quarantineChunk(chunk);
      const chunkTokens = this.estimateTokens(quarantined);

      if (currentTokens + chunkTokens <= maxTokens) {
        packedSnippets.push(quarantined);
        includedSources.push(chunk.source);
        currentTokens += chunkTokens;
      } else {
        // Try fitting a truncated version if we have at least 100 tokens remaining
        const remainingTokens = maxTokens - currentTokens;
        if (remainingTokens >= 100) {
          const truncatedQuarantine = this.quarantineChunk({
            ...chunk,
            content: this.truncateToTokenLimit(chunk.content, remainingTokens - 20)
          });
          packedSnippets.push(truncatedQuarantine);
          includedSources.push(chunk.source + ' (partial)');
          currentTokens += this.estimateTokens(truncatedQuarantine);
        }
        break;
      }
    }

    const report: ContextBudgetReport = {
      totalBudgetTokens: this._totalBudget,
      allocatedTokens: { ...this._budgets },
      usedTokens: {
        systemAndTools: 0,
        repoMap: 0,
        planAndTask: 0,
        codeChunks: currentTokens,
        totalPrompt: currentTokens,
        availableForOutput: this._totalBudget - currentTokens
      },
      truncatedChunksCount: this._truncatedCount,
      quarantinedChunksCount: this._quarantinedCount
    };

    return {
      packedText: packedSnippets.join('\n\n'),
      includedSources,
      report
    };
  }
}
