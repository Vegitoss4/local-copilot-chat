export interface RouteDecision {
  model: string;
  reason: string;
  intent: 'reasoning' | 'coding' | 'agent' | 'default';
}

export class ModelRouter {
  private static readonly REASONING_KEYWORDS = [
    'why', 'explain', 'design', 'architect', 'architecture', 'plan', 'debug',
    'trace', 'analyze', 'analysis', 'structure', 'how does', 'compare',
    'difference', 'review', 'audit', 'evaluate', 'investigate', 'root cause'
  ];

  private static readonly CODING_KEYWORDS = [
    'write', 'generate', 'create', 'fix', 'refactor', 'add', 'component',
    'endpoint', 'implement', 'code', 'function', 'class', 'method', 'patch',
    'controller', 'service', 'model', 'html', 'css', 'typescript', 'csharp',
    'dotnet', 'angular', 'unit test', 'test', 'syntax', 'bug', 'error'
  ];

  /**
   * Fast heuristic intent classifier that maps user prompt to the optimal local model
   * without incurring LLM inference latency or VRAM overhead.
   */
  public static route(
    prompt: string,
    mode: 'chat' | 'agent' = 'chat',
    availableModels: string[] = []
  ): string {
    const decision = this.classifyIntent(prompt, mode, availableModels);
    return decision.model;
  }

  public static classifyIntent(
    prompt: string,
    mode: 'chat' | 'agent' = 'chat',
    availableModels: string[] = []
  ): RouteDecision {
    const lower = prompt.toLowerCase();

    const deepSeek = availableModels.find(m => m.toLowerCase().includes('deepseek-r1')) || 'deepseek-r1:8b';
    const qwenCoder = availableModels.find(m => m.toLowerCase().includes('qwen2.5-coder')) || 'qwen2.5-coder:7b';
    const qwen35 = availableModels.find(m => m.toLowerCase().includes('qwen3.5')) || 'qwen3.5:9b';

    // Rule 3: Agent Mode Override - Swarm Orchestrator begins with architectural reasoning
    if (mode === 'agent') {
      const selected = deepSeek || qwen35 || qwenCoder;
      return {
        model: selected,
        reason: 'Agent Mode active: Starting with architectural orchestrator/planner model',
        intent: 'agent'
      };
    }

    // Rule 1: Reasoning / Architecture / Analysis
    const hasReasoning = this.REASONING_KEYWORDS.some(kw => {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      return regex.test(lower);
    });

    if (hasReasoning) {
      const selected = deepSeek || qwen35 || qwenCoder;
      return {
        model: selected,
        reason: `Reasoning intent detected: Routing to ${selected}`,
        intent: 'reasoning'
      };
    }

    // Rule 2: Execution / Syntax / Coding
    const hasCoding = this.CODING_KEYWORDS.some(kw => {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      return regex.test(lower);
    });

    if (hasCoding) {
      const selected = qwenCoder || qwen35 || deepSeek;
      return {
        model: selected,
        reason: `Code synthesis intent detected: Routing to ${selected}`,
        intent: 'coding'
      };
    }

    // Default fallback
    const defaultModel = qwenCoder || qwen35 || deepSeek;
    return {
      model: defaultModel,
      reason: `Default fallback to coding model: ${defaultModel}`,
      intent: 'default'
    };
  }
}
