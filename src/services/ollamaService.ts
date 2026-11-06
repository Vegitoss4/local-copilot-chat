import { ToolDefinition } from './agentToolService';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
  name?: string;
}

export interface OllamaChatResponse {
  message: ChatMessage;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaService {
  private endpoint: string;

  constructor(endpoint: string = 'http://127.0.0.1:11434') {
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  public setEndpoint(endpoint: string) {
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  public getEndpoint(): string {
    return this.endpoint;
  }

  public async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Ollama returned status ${response.status}`);
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      if (!data.models || !Array.isArray(data.models)) {
        return [];
      }

      return data.models.map((m) => m.name);
    } catch (err: any) {
      console.error('Failed to query Ollama models:', err);
      throw new Error(
        `Unable to connect to Ollama at ${this.endpoint}. Please make sure Ollama is running.`
      );
    }
  }

  /**
   * Plain text / markdown streaming chat with AbortController support
   */
  public async streamChat(
    model: string,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    options: Record<string, any> = { num_ctx: 16384, temperature: 0.2 }
  ): Promise<string> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: this.cleanMessagesForOllama(messages),
        stream: true,
        options,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error (${response.status}): ${errorText || response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Readable stream not supported on Ollama response.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullResponse = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.message?.content) {
            const content = parsed.message.content;
            fullResponse += content;
            onChunk(content);
          }
        } catch {
          // Incomplete chunk
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.message?.content) {
          fullResponse += parsed.message.content;
          onChunk(parsed.message.content);
        }
      } catch {
        // ignore
      }
    }

    return fullResponse;
  }

  /**
   * Tool Calling invocation (uses native Ollama tools parameter + text fallback extraction)
   */
  public async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    options: Record<string, any> = { num_ctx: 16384, temperature: 0.1 }
  ): Promise<ChatMessage> {
    const payload = {
      model,
      messages: this.cleanMessagesForOllama(messages),
      tools: tools.length > 0 ? tools : undefined,
      stream: false,
      options,
    };

    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama Tool Call Error (${response.status}): ${errorText || response.statusText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const msg = data.message;

    // Check for native Ollama tool_calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return msg;
    }

    // Fallback: If local model emitted tool call inside raw content (e.g. ```json {"tool": ...} or <tool_call>)
    const extractedCalls = this.extractToolCallsFromContent(msg.content);
    if (extractedCalls.length > 0) {
      msg.tool_calls = extractedCalls;
    }

    return msg;
  }

  /**
   * VRAM-aware model unloading via Ollama keep_alive: 0
   * Immediately releases 4-8 GB of GPU memory before loading the next agent's model
   */
  public async unloadModel(modelName: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          keep_alive: 0,
        }),
      });
      return response.ok;
    } catch (err) {
      console.warn(`Failed to unload model ${modelName}:`, err);
      return false;
    }
  }

  /**
   * Resolves the specialized model for an agent persona:
   * - Orchestrator & Planner: DeepSeek-R1 (or Qwen 3.5:9b) for architectural reasoning & thought
   * - Coder & Tester: Qwen 2.5 Coder (or Qwen 3.5:9b) for precise tool-calling & syntax accuracy
   */
  public resolveModelForRole(
    role: 'orchestrator' | 'planner' | 'coder' | 'tester',
    userSelectedModel: string,
    availableModels: string[]
  ): string {
    const deepSeek = availableModels.find(m => m.toLowerCase().includes('deepseek-r1'));
    const qwen35 = availableModels.find(m => m.toLowerCase().includes('qwen3.5'));
    const qwenCoder = availableModels.find(m => m.toLowerCase().includes('qwen2.5-coder'));

    if (availableModels.length === 1) {
      return availableModels[0];
    }

    if (role === 'orchestrator' || role === 'planner') {
      return deepSeek || qwen35 || userSelectedModel;
    }

    // Coder and Tester
    return qwenCoder || qwen35 || userSelectedModel;
  }

  /**
   * Model orchestration helper:
   * Selects reasoning model (e.g. deepseek-r1) or coder model (qwen3.5:9b / qwen2.5-coder)
   */
  public resolveModelForPhase(
    phase: 'planning' | 'execution',
    userSelectedModel: string,
    availableModels: string[]
  ): string {
    const deepSeek = availableModels.find(m => m.toLowerCase().includes('deepseek-r1'));
    const qwen35 = availableModels.find(m => m.toLowerCase().includes('qwen3.5'));
    const qwenCoder = availableModels.find(m => m.toLowerCase().includes('qwen2.5-coder'));

    // If user explicitly selected qwen3.5:9b, respect user choice directly
    if (userSelectedModel.toLowerCase().includes('qwen3.5')) {
      return qwen35 || userSelectedModel;
    }

    // If user selected deepseek-r1:8b
    if (userSelectedModel.toLowerCase().includes('deepseek-r1')) {
      if (phase === 'planning') {
        return deepSeek || userSelectedModel;
      }
      // For tool-calling execution phase, route to qwen3.5:9b or qwen2.5-coder:7b for precise JSON tool execution
      return qwen35 || qwenCoder || userSelectedModel;
    }

    // If user selected qwen2.5-coder:7b, optionally use DeepSeek for initial architectural planning if available
    if (phase === 'planning' && deepSeek) {
      return deepSeek;
    }

    return userSelectedModel;
  }

  private cleanMessagesForOllama(messages: ChatMessage[]): any[] {
    return messages.map(m => {
      const base: any = { role: m.role, content: m.content || '' };
      if (m.tool_calls && m.tool_calls.length > 0) {
        base.tool_calls = m.tool_calls;
      }
      return base;
    });
  }

  /**
   * Resilient fallback parser for models that output tool calls in XML or JSON markdown blocks
   */
  private extractToolCallsFromContent(content: string): Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }> {
    const calls: Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }> = [];
    if (!content) return calls;

    // Pattern 1: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
    const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;
    while ((match = xmlRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.name) {
          calls.push({
            id: 'call_' + Math.random().toString(36).slice(2, 9),
            function: {
              name: parsed.name,
              arguments: parsed.arguments || parsed.parameters || {},
            },
          });
        }
      } catch {}
    }

    if (calls.length > 0) return calls;

    // Pattern 2: ```json { "tool": "str_replace", "arguments": { ... } } ```
    const codeBlockRegex = /```(?:json)?\s*\n?(\{[\s\S]*?"(?:name|tool)"\s*:\s*"[\s\S]*?\})\s*```/g;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const toolName = parsed.name || parsed.tool;
        if (toolName) {
          calls.push({
            id: 'call_' + Math.random().toString(36).slice(2, 9),
            function: {
              name: toolName,
              arguments: parsed.arguments || parsed.parameters || {},
            },
          });
        }
      } catch {}
    }

    return calls;
  }
}
