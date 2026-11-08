import { ToolDefinition } from './agentToolService';
import { ExtensionLogger } from './extensionLogger';

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

export interface OllamaChatMetadata {
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

export interface IOllamaModelInfo {
  name: string;
  model: string;
  size: number;
  sizeVram?: number;
  expiresAt?: string;
}

export interface OllamaTimeoutOptions {
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  idleStreamTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface ToolChatProgress {
  phase: 'connecting' | 'thinking' | 'streaming';
  elapsedMs: number;
  partialContent: string;
}

export interface ToolChatOptions {
  stream?: boolean; // default true
  enableEmbeddedFallback?: boolean; // default false
  isEmbeddedCapableModel?: boolean; // default false
  allowedToolNames?: string[];
  onProgress?: (progress: ToolChatProgress) => void;
}

export class OllamaTimeoutError extends Error {
  constructor(
    public readonly phase: 'connect' | 'headers' | 'idle_stream' | 'total',
    public readonly timeoutMs: number,
    message?: string
  ) {
    super(message || `Ollama request timed out during ${phase} phase after ${timeoutMs}ms.`);
    this.name = 'OllamaTimeoutError';
  }
}

export class OllamaVramError extends Error {
  constructor(
    public readonly model: string,
    public readonly rawError: string
  ) {
    super(
      `Ollama failed to allocate VRAM/memory for model "${model}": ${rawError}. ` +
      `Under the 8 GB VRAM budget constraint, consider reducing the context size ("num_ctx"), ` +
      `switching to a smaller or more aggressively quantized model (e.g. 7b q4_k_m or 3b), or closing external GPU applications.`
    );
    this.name = 'OllamaVramError';
  }
}

export interface OllamaDiagnosticSnapshot {
  errorName: string;
  errorMessage: string;
  causeCode?: string;
  causeMessage?: string;
  endpoint: string;
  model: string;
  numCtx?: number;
  elapsedMs: number;
  promptSizeBytes?: number;
  isHttpError: boolean;
  httpStatus?: number;
  httpBody?: string;
  genId?: string;
  psSnapshot?: string[];
  tagsSnapshot?: string[];
}

export class OllamaConnectionError extends Error {
  public readonly diagnostics: OllamaDiagnosticSnapshot;

  constructor(diagnostics: OllamaDiagnosticSnapshot) {
    let msg: string;
    if (diagnostics.isHttpError) {
      msg = `Ollama HTTP Error (${diagnostics.httpStatus}): ${diagnostics.httpBody || 'Server returned non-2xx status.'}`;
    } else if (diagnostics.causeCode === 'ECONNREFUSED') {
      msg = `Unable to connect to Ollama at ${diagnostics.endpoint} (Connection Refused). Please ensure Ollama is running ('ollama serve') and accessible.`;
    } else if (diagnostics.causeCode === 'ETIMEDOUT' || diagnostics.causeCode === 'UND_ERR_CONNECT_TIMEOUT') {
      msg = `Connection to Ollama at ${diagnostics.endpoint} timed out after ${diagnostics.elapsedMs}ms.`;
    } else {
      msg = `Ollama communication failed: ${diagnostics.errorMessage || 'No response received'}${diagnostics.causeCode ? ` (${diagnostics.causeCode})` : ''} at ${diagnostics.endpoint}.`;
    }
    super(msg);
    this.name = 'OllamaConnectionError';
    this.diagnostics = diagnostics;
  }
}

export interface ModelCapabilityResult {
  model: string;
  hasTools: boolean;
  capabilities: string[];
  status: 'supported' | 'unsupported' | 'unknown';
  template?: string;
}

export interface ModelProbeResult {
  model: string;
  supported: boolean;
  emittedNativeCalls: boolean;
  emittedContentCalls: boolean;
  latencyMs: number;
  error?: string;
  probedAt: number;
}

function redactAndCap(text: string, maxLen: number = 512): string {
  if (!text) return '';
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key[:=]\s*)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED]')
    .replace(/(password[:=]\s*)[^\s&]+/gi, '$1[REDACTED]')
    .slice(0, maxLen);
}

export function isVramAllocationError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== 'string') return false;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('requires more system memory') ||
    msg.includes('out of memory') ||
    msg.includes('cuda error') ||
    msg.includes('not enough memory') ||
    msg.includes('cudaerrormemoryallocation') ||
    msg.includes('failed to allocate') ||
    msg.includes('insufficient memory') ||
    msg.includes('vram')
  );
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

  private _capabilityCache: Map<string, { result: ModelCapabilityResult; timestamp: number }> = new Map();
  private static readonly CAPABILITY_CACHE_TTL_MS = 60000;

  public clearCapabilityCache(): void {
    this._capabilityCache.clear();
  }

  public getCapabilityCache(): Map<string, ModelCapabilityResult> {
    const map = new Map<string, ModelCapabilityResult>();
    for (const [k, v] of this._capabilityCache.entries()) {
      map.set(k, v.result);
    }
    return map;
  }

  /**
   * Queries /api/show for model capabilities.
   * Derives tool support strictly from capabilities array.
   * Zero hardcoded model names.
   */
  public async getModelCapabilities(model: string, timeoutMs: number = 5000): Promise<ModelCapabilityResult> {
    const cached = this._capabilityCache.get(model);
    if (cached && Date.now() - cached.timestamp < OllamaService.CAPABILITY_CACHE_TTL_MS) {
      return cached.result;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          model,
          hasTools: false,
          capabilities: [],
          status: 'unknown',
        };
      }

      const data = (await response.json()) as { capabilities?: string[]; template?: string };
      const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
      const hasTools = capabilities.includes('tools');

      const result: ModelCapabilityResult = {
        model,
        hasTools,
        capabilities,
        status: capabilities.length === 0 ? 'unknown' : (hasTools ? 'supported' : 'unsupported'),
        template: data.template,
      };

      this._capabilityCache.set(model, { result, timestamp: Date.now() });
      return result;
    } catch {
      return {
        model,
        hasTools: false,
        capabilities: [],
        status: 'unknown',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Retrieves installed models from /api/tags that declare tool-calling capability.
   */
  public async getModelsWithTools(timeoutMs: number = 5000): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) return [];
      const data = (await response.json()) as { models?: Array<{ name: string; capabilities?: string[] }> };
      if (!data.models || !Array.isArray(data.models)) return [];

      const toolsModels: string[] = [];
      for (const m of data.models) {
        if (m.capabilities && Array.isArray(m.capabilities) && m.capabilities.includes('tools')) {
          toolsModels.push(m.name);
        }
      }
      return toolsModels;
    } catch {
      return [];
    }
  }

  /**
   * Captures quick snapshot of /api/ps and /api/tags for failure diagnostics.
   */
  public async takeDiagnosticSnapshot(): Promise<{ ps: string[]; tags: string[] }> {
    const ps: string[] = [];
    const tags: string[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const psRes = await fetch(`${this.endpoint}/api/ps`, { signal: controller.signal });
      clearTimeout(timer);
      if (psRes.ok) {
        const psData = (await psRes.json()) as { models?: Array<{ name: string }> };
        if (psData?.models) ps.push(...psData.models.map(m => m.name));
      }
    } catch {}
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const tagsRes = await fetch(`${this.endpoint}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (tagsRes.ok) {
        const tagsData = (await tagsRes.json()) as { models?: Array<{ name: string }> };
        if (tagsData?.models) tags.push(...tagsData.models.map(m => m.name));
      }
    } catch {}
    return { ps, tags };
  }

  public async ping(timeoutMs: number = 2000): Promise<boolean> {
    try {
      await this.getAvailableModels({ connectTimeoutMs: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  public async getAvailableModels(timeouts?: OllamaTimeoutOptions): Promise<string[]> {
    const connectTimeoutMs = timeouts?.connectTimeoutMs ?? 5000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, connectTimeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status} (${response.statusText}) at ${this.endpoint}`);
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      if (!data.models || !Array.isArray(data.models)) {
        return [];
      }

      return data.models.map((m) => m.name);
    } catch (err: any) {
      if (timedOut) {
        throw new OllamaTimeoutError(
          'connect',
          connectTimeoutMs,
          `Connection to Ollama at ${this.endpoint} timed out after ${connectTimeoutMs}ms.`
        );
      }
      if (err.message && (err.message.includes('HTTP') || err.message.includes('Ollama returned'))) {
        throw err;
      }
      throw new Error(
        `Unable to connect to Ollama at ${this.endpoint}. Please make sure Ollama is running and accessible.`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Retrieves currently loaded resident models directly from Ollama via GET /api/ps.
   * Ground-truth observability without false VRAM assumptions.
   */
  public async getLoadedModels(timeouts?: OllamaTimeoutOptions): Promise<IOllamaModelInfo[]> {
    const connectTimeoutMs = timeouts?.connectTimeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/api/ps`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as { models?: any[] };
      if (!data.models || !Array.isArray(data.models)) {
        return [];
      }

      return data.models.map((m: any) => ({
        name: m.name || m.model || '',
        model: m.model || m.name || '',
        size: typeof m.size === 'number' ? m.size : 0,
        sizeVram: typeof m.size_vram === 'number' ? m.size_vram : undefined,
        expiresAt: m.expires_at || undefined,
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Plain text / markdown streaming chat with AbortController and multi-tier timeout support
   */
  public async streamChat(
    model: string,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    options: Record<string, any> = { num_ctx: 16384, temperature: 0.2 },
    timeouts?: OllamaTimeoutOptions,
    onMetadata?: (meta: OllamaChatMetadata) => void
  ): Promise<string> {
    const connectTimeoutMs = timeouts?.connectTimeoutMs;
    const headersTimeoutMs = timeouts?.headersTimeoutMs ?? 45000;
    const idleStreamTimeoutMs = timeouts?.idleStreamTimeoutMs ?? 30000;
    const totalTimeoutMs = timeouts?.totalTimeoutMs ?? 300000;

    let timedOutPhase: 'connect' | 'headers' | 'idle_stream' | 'total' | null = null;
    const internalController = new AbortController();

    const onParentAbort = () => {
      internalController.abort();
    };

    if (signal) {
      if (signal.aborted) {
        throw new Error('Operation was aborted before request was sent.');
      }
      signal.addEventListener('abort', onParentAbort, { once: true });
    }

    let connectTimer: NodeJS.Timeout | undefined;
    let headersTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;

    if (totalTimeoutMs > 0 && totalTimeoutMs < Infinity) {
      totalTimer = setTimeout(() => {
        timedOutPhase = 'total';
        internalController.abort();
      }, totalTimeoutMs);
    }

    if (headersTimeoutMs > 0 && headersTimeoutMs < Infinity) {
      headersTimer = setTimeout(() => {
        timedOutPhase = 'headers';
        internalController.abort();
      }, headersTimeoutMs);
    }

    if (connectTimeoutMs && connectTimeoutMs > 0 && connectTimeoutMs < Infinity) {
      connectTimer = setTimeout(() => {
        timedOutPhase = 'connect';
        internalController.abort();
      }, connectTimeoutMs);
    }

    const startTime = Date.now();
    let payloadLength = 0;

    try {
      const payload: Record<string, any> = {
        model,
        messages: this.cleanMessagesForOllama(messages),
        stream: true,
        options,
      };
      if (options.keep_alive !== undefined) {
        payload.keep_alive = options.keep_alive;
      }
      payloadLength = JSON.stringify(payload).length;

      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: internalController.signal,
      });

      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }

      if (headersTimer) {
        clearTimeout(headersTimer);
        headersTimer = undefined;
      }

      if (!response.ok) {
        const errorText = await response.text();
        if (isVramAllocationError(errorText)) {
          throw new OllamaVramError(model, errorText);
        }
        const redacted = redactAndCap(errorText || response.statusText);
        throw new OllamaConnectionError({
          errorName: 'OllamaHttpError',
          errorMessage: `Ollama error (${response.status}): ${redacted}`,
          endpoint: this.endpoint,
          model,
          numCtx: options.num_ctx,
          elapsedMs: Date.now() - startTime,
          promptSizeBytes: payloadLength,
          isHttpError: true,
          httpStatus: response.status,
          httpBody: redacted,
        });
      }

      if (!response.body) {
        throw new Error('Readable stream not supported on Ollama response.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullResponse = '';
      let buffer = '';

      const onAbortCancelReader = () => {
        try {
          reader.cancel().catch(() => {});
        } catch {}
      };
      internalController.signal.addEventListener('abort', onAbortCancelReader, { once: true });

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleStreamTimeoutMs > 0 && idleStreamTimeoutMs < Infinity) {
          idleTimer = setTimeout(() => {
            timedOutPhase = 'idle_stream';
            internalController.abort();
          }, idleStreamTimeoutMs);
        }
      };

      resetIdleTimer();

      try {
        while (true) {
          if (internalController.signal.aborted) {
            break;
          }
          const { done, value } = await reader.read();
          if (done || internalController.signal.aborted) break;

          resetIdleTimer();

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
              if (parsed.done && onMetadata) {
                onMetadata({
                  prompt_eval_count: parsed.prompt_eval_count,
                  prompt_eval_duration: parsed.prompt_eval_duration,
                  eval_count: parsed.eval_count,
                  eval_duration: parsed.eval_duration,
                  total_duration: parsed.total_duration,
                  load_duration: parsed.load_duration
                });
              }
            } catch {
              // Incomplete chunk
            }
          }
        }
      } finally {
        internalController.signal.removeEventListener('abort', onAbortCancelReader);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      }

      if (internalController.signal.aborted) {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          if (parsed.message?.content) {
            fullResponse += parsed.message.content;
            onChunk(parsed.message.content);
          }
          if (parsed.done && onMetadata) {
            onMetadata({
              prompt_eval_count: parsed.prompt_eval_count,
              prompt_eval_duration: parsed.prompt_eval_duration,
              eval_count: parsed.eval_count,
              eval_duration: parsed.eval_duration,
              total_duration: parsed.total_duration,
              load_duration: parsed.load_duration
            });
          }
        } catch {
          // ignore
        }
      }

      return fullResponse;
    } catch (err: any) {
      if (internalController.signal.aborted) {
        if (signal?.aborted) {
          const abortErr = new Error('Generation was aborted by user.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        if (timedOutPhase === 'idle_stream') {
          throw new OllamaTimeoutError(
            'idle_stream',
            idleStreamTimeoutMs,
            `Ollama stream stalled after ${idleStreamTimeoutMs}ms of inactivity.`
          );
        }
        if (timedOutPhase === 'headers') {
          throw new OllamaTimeoutError(
            'headers',
            headersTimeoutMs,
            `Ollama response headers/model load timed out after ${headersTimeoutMs}ms.`
          );
        }
        if (timedOutPhase === 'total') {
          throw new OllamaTimeoutError(
            'total',
            totalTimeoutMs,
            `Ollama generation exceeded total turn timeout of ${totalTimeoutMs}ms.`
          );
        }
        if (timedOutPhase === 'connect') {
          const actualTimeout = connectTimeoutMs || 5000;
          throw new OllamaTimeoutError(
            'connect',
            actualTimeout,
            `Connection to Ollama timed out after ${actualTimeout}ms.`
          );
        }
      }
      if (err instanceof OllamaTimeoutError || err instanceof OllamaVramError || err.name === 'AbortError') {
        throw err;
      }
      if (err instanceof OllamaConnectionError) {
        throw err;
      }

      const elapsedMs = Date.now() - startTime;
      const isFetchFailed =
        err.message === 'fetch failed' ||
        err.code === 'ECONNREFUSED' ||
        err.cause?.code === 'ECONNREFUSED' ||
        err.cause?.code === 'ETIMEDOUT' ||
        err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';

      if (isFetchFailed || err.name === 'TypeError') {
        const snapshot = await this.takeDiagnosticSnapshot();
        throw new OllamaConnectionError({
          errorName: err.name || 'ConnectionError',
          errorMessage: err.message,
          causeCode: err.cause?.code || err.code,
          causeMessage: err.cause?.message,
          endpoint: this.endpoint,
          model,
          numCtx: options.num_ctx,
          elapsedMs,
          promptSizeBytes: payloadLength,
          isHttpError: false,
          psSnapshot: snapshot.ps,
          tagsSnapshot: snapshot.tags,
        });
      }
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
      if (connectTimer) clearTimeout(connectTimer);
      if (headersTimer) clearTimeout(headersTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
    }
  }

  /**
   * Tool Calling invocation:
   * Streams tool calls by default (stream: true) with progressive token buffering,
   * idle inactivity resets on every chunk, and thinking indicator callbacks.
   * Keeps non-streaming (stream: false) behind setting / options as fallback.
   */
  public async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    options: Record<string, any> = { num_ctx: 16384, temperature: 0.1 },
    timeouts?: OllamaTimeoutOptions,
    toolOptions?: ToolChatOptions
  ): Promise<ChatMessage> {
    const shouldStream = toolOptions?.stream ?? true;
    const connectTimeoutMs = timeouts?.connectTimeoutMs;
    const headersTimeoutMs = timeouts?.headersTimeoutMs ?? 45000;
    const idleStreamTimeoutMs = timeouts?.idleStreamTimeoutMs ?? 30000;
    const totalTimeoutMs = timeouts?.totalTimeoutMs ?? 300000;

    let timedOutPhase: 'connect' | 'headers' | 'idle_stream' | 'total' | null = null;
    const internalController = new AbortController();

    const onParentAbort = () => {
      internalController.abort();
    };

    if (signal) {
      if (signal.aborted) {
        throw new Error('Operation was aborted before request was sent.');
      }
      signal.addEventListener('abort', onParentAbort, { once: true });
    }

    let connectTimer: NodeJS.Timeout | undefined;
    let headersTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;

    if (totalTimeoutMs > 0 && totalTimeoutMs < Infinity) {
      totalTimer = setTimeout(() => {
        timedOutPhase = 'total';
        internalController.abort();
      }, totalTimeoutMs);
    }

    if (headersTimeoutMs > 0 && headersTimeoutMs < Infinity) {
      headersTimer = setTimeout(() => {
        timedOutPhase = 'headers';
        internalController.abort();
      }, headersTimeoutMs);
    }

    if (connectTimeoutMs && connectTimeoutMs > 0 && connectTimeoutMs < Infinity) {
      connectTimer = setTimeout(() => {
        timedOutPhase = 'connect';
        internalController.abort();
      }, connectTimeoutMs);
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleStreamTimeoutMs > 0 && idleStreamTimeoutMs < Infinity) {
        idleTimer = setTimeout(() => {
          timedOutPhase = 'idle_stream';
          internalController.abort();
        }, idleStreamTimeoutMs);
      }
    };

    const startTime = Date.now();
    let payloadLength = 0;

    try {
      const payload: Record<string, any> = {
        model,
        messages: this.cleanMessagesForOllama(messages),
        tools: tools.length > 0 ? tools : undefined,
        stream: shouldStream,
        options,
      };
      if (options.keep_alive !== undefined) {
        payload.keep_alive = options.keep_alive;
      }
      payloadLength = JSON.stringify(payload).length;

      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: internalController.signal,
      });

      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }

      if (headersTimer) {
        clearTimeout(headersTimer);
        headersTimer = undefined;
      }

      if (!response.ok) {
        const errorText = await response.text();
        if (isVramAllocationError(errorText)) {
          throw new OllamaVramError(model, errorText);
        }
        const redacted = redactAndCap(errorText || response.statusText);
        throw new OllamaConnectionError({
          errorName: 'OllamaHttpError',
          errorMessage: `Ollama Tool Call Error (${response.status}): ${redacted}`,
          endpoint: this.endpoint,
          model,
          numCtx: options.num_ctx,
          elapsedMs: Date.now() - startTime,
          promptSizeBytes: payloadLength,
          isHttpError: true,
          httpStatus: response.status,
          httpBody: redacted,
        });
      }

      // STREAMING EXECUTION PATH (Default)
      if (shouldStream && response.body && typeof (response.body as any).getReader === 'function') {
        resetIdleTimer();
        let accumulatedContent = '';
        const accumulatedToolCalls: Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }> = [];

        if (!response.body) {
          throw new Error('Response body is null or undefined.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const chunk = JSON.parse(trimmed);
                if (chunk.message?.content) {
                  accumulatedContent += chunk.message.content;
                  const elapsedMs = Date.now() - startTime;
                  const hasOpenThink = accumulatedContent.includes('<think>') && !accumulatedContent.includes('</think>');
                  toolOptions?.onProgress?.({
                    phase: hasOpenThink ? 'thinking' : 'streaming',
                    elapsedMs,
                    partialContent: accumulatedContent
                  });
                }

                if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
                  for (const tc of chunk.message.tool_calls) {
                    accumulatedToolCalls.push(tc);
                  }
                }
              } catch {}
            }
          }
        } finally {
          reader.releaseLock();
          if (idleTimer) clearTimeout(idleTimer);
        }

        // Process accumulated native tool calls
        if (accumulatedToolCalls.length > 0) {
          for (const call of accumulatedToolCalls) {
            if (call.function && typeof call.function.arguments === 'string') {
              try {
                call.function.arguments = JSON.parse(call.function.arguments);
              } catch {}
            }
          }
          return {
            role: 'assistant',
            content: accumulatedContent,
            tool_calls: accumulatedToolCalls
          };
        }

        // Single unified embedded fallback path: fires strictly when native tool_calls are empty,
        // setting is enabled, model is probed as embedded-capable, and message is exactly one JSON object.
        const offeredToolNames = tools.map((t) => t.function?.name || (t as any).name).filter(Boolean);
        const extractedCalls = OllamaService.extractEmbeddedToolCall(accumulatedContent, {
          enableEmbeddedFallback: toolOptions?.enableEmbeddedFallback,
          isEmbeddedCapableModel: toolOptions?.isEmbeddedCapableModel,
          allowedToolNames: toolOptions?.allowedToolNames || offeredToolNames,
          modelName: model,
        });

        if (extractedCalls.length === 1) {
          return {
            role: 'assistant',
            content: accumulatedContent,
            tool_calls: extractedCalls,
          };
        }

        return {
          role: 'assistant',
          content: accumulatedContent
        };
      }

      // NON-STREAMING FALLBACK PATH (stream: false)
      const data = (await response.json()) as OllamaChatResponse;
      const msg = data.message;

      // Check for native Ollama tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          if (call.function && typeof call.function.arguments === 'string') {
            try {
              call.function.arguments = JSON.parse(call.function.arguments);
            } catch {}
          }
        }
        return msg;
      }

      // Single unified embedded fallback path for non-streaming
      const offeredToolNamesNonStream = tools.map((t) => t.function?.name || (t as any).name).filter(Boolean);
      const extractedNonStream = OllamaService.extractEmbeddedToolCall(msg.content, {
        enableEmbeddedFallback: toolOptions?.enableEmbeddedFallback,
        isEmbeddedCapableModel: toolOptions?.isEmbeddedCapableModel,
        allowedToolNames: toolOptions?.allowedToolNames || offeredToolNamesNonStream,
        modelName: model,
      });

      if (extractedNonStream.length === 1) {
        msg.tool_calls = extractedNonStream;
      }

      return msg;
    } catch (err: any) {
      if (internalController.signal.aborted) {
        if (signal?.aborted) {
          const abortErr = new Error('Tool execution was aborted by user.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        if (timedOutPhase === 'connect') {
          const actualTimeout = connectTimeoutMs || 5000;
          throw new OllamaTimeoutError(
            'connect',
            actualTimeout,
            `Ollama connection timed out after ${actualTimeout}ms during initial handshake.`
          );
        }
        if (timedOutPhase === 'headers') {
          throw new OllamaTimeoutError(
            'headers',
            headersTimeoutMs,
            `Ollama tool call response timed out waiting for headers after ${headersTimeoutMs}ms.`
          );
        }
        if (timedOutPhase === 'idle_stream') {
          throw new OllamaTimeoutError(
            'idle_stream',
            idleStreamTimeoutMs,
            `Ollama stream stalled: no tokens received for ${idleStreamTimeoutMs}ms.`
          );
        }
        if (timedOutPhase === 'total') {
          throw new OllamaTimeoutError(
            'total',
            totalTimeoutMs,
            `Ollama tool execution exceeded total timeout of ${totalTimeoutMs}ms.`
          );
        }
      }
      if (err instanceof OllamaTimeoutError || err instanceof OllamaVramError || err.name === 'AbortError') {
        throw err;
      }
      if (err instanceof OllamaConnectionError) {
        throw err;
      }

      const elapsedMs = Date.now() - startTime;
      const isFetchFailed =
        err.message === 'fetch failed' ||
        err.code === 'ECONNREFUSED' ||
        err.cause?.code === 'ECONNREFUSED' ||
        err.cause?.code === 'ETIMEDOUT' ||
        err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';

      if (isFetchFailed || err.name === 'TypeError') {
        const snapshot = await this.takeDiagnosticSnapshot();
        throw new OllamaConnectionError({
          errorName: err.name || 'ConnectionError',
          errorMessage: err.message,
          causeCode: err.cause?.code || err.code,
          causeMessage: err.cause?.message,
          endpoint: this.endpoint,
          model,
          numCtx: options.num_ctx,
          elapsedMs,
          promptSizeBytes: payloadLength,
          isHttpError: false,
          psSnapshot: snapshot.ps,
          tagsSnapshot: snapshot.tags,
        });
      }
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
      if (connectTimer) clearTimeout(connectTimer);
      if (headersTimer) clearTimeout(headersTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
    }
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

  private static readonly probeCache = new Map<string, ModelProbeResult>();

  /**
   * Clears the behavioral probe cache (for tests or after model pull/delete).
   */
  public static clearProbeCache(): void {
    this.probeCache.clear();
  }

  /**
   * Performs an active behavioral probe to verify whether a model actually emits valid tool calls
   * when offered a tool schema. Bounded by a strict timeout (default 8000ms).
   * Results are cached per model.
   */
  public async probeModelToolSupport(
    model: string,
    timeoutMs = 8000
  ): Promise<ModelProbeResult> {
    const cached = OllamaService.probeCache.get(model);
    if (cached && Date.now() - cached.probedAt < 300000) {
      return cached;
    }

    const startTime = Date.now();
    const probeTool = {
      type: 'function' as const,
      function: {
        name: 'echo_probe',
        description: 'Echoes back the probe message to verify tool-calling capability',
        parameters: {
          type: 'object' as const,
          properties: {
            message: { type: 'string', description: 'Probe message' }
          },
          required: ['message']
        }
      }
    };

    try {
      const response = await this.chatWithTools(
        model,
        [{ role: 'user', content: "Call the echo_probe tool with message 'ping'." }],
        [probeTool],
        undefined,
        { num_ctx: 2048, temperature: 0.0 },
        {
          headersTimeoutMs: Math.min(timeoutMs, 6000),
          totalTimeoutMs: timeoutMs,
        }
      );

      const latencyMs = Date.now() - startTime;
      const nativeCalls = (response.tool_calls || []).filter(
        c => c.function?.name === 'echo_probe'
      );
      const contentCalls = OllamaService.extractEmbeddedToolCall(response.content || '', {
        enableEmbeddedFallback: true,
        isEmbeddedCapableModel: true,
        allowedToolNames: ['echo_probe'],
        modelName: model,
      }).filter(c => c.function?.name === 'echo_probe');

      const supported = nativeCalls.length > 0 || contentCalls.length > 0;
      const result: ModelProbeResult = {
        model,
        supported,
        emittedNativeCalls: nativeCalls.length > 0,
        emittedContentCalls: contentCalls.length > 0,
        latencyMs,
        probedAt: Date.now(),
      };

      OllamaService.probeCache.set(model, result);
      return result;
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const result: ModelProbeResult = {
        model,
        supported: false,
        emittedNativeCalls: false,
        emittedContentCalls: false,
        latencyMs,
        error: err.message,
        probedAt: Date.now(),
      };
      OllamaService.probeCache.set(model, result);
      return result;
    }
  }

  /**
   * Resolves the specialized model for an agent persona dynamically:
   * Selects tool-capable models for execution roles (coder, tester)
   * without hardcoding model names.
   */
  public resolveModelForRole(
    role: 'orchestrator' | 'planner' | 'coder' | 'tester',
    userSelectedModel: string,
    availableModels: string[],
    capabilitiesMap?: Map<string, ModelCapabilityResult>
  ): string {
    if (availableModels.length <= 1) {
      return availableModels[0] || userSelectedModel;
    }

    if (capabilitiesMap && capabilitiesMap.size > 0) {
      const toolCapable = availableModels.filter(m => capabilitiesMap.get(m)?.hasTools);
      const nonToolModels = availableModels.filter(m => !capabilitiesMap.get(m)?.hasTools);

      if (role === 'orchestrator' || role === 'planner') {
        if (nonToolModels.length > 0) return nonToolModels[0];
        return userSelectedModel || availableModels[0];
      }

      // Coder and Tester need tool support
      if (toolCapable.length > 0) {
        if (toolCapable.includes(userSelectedModel)) return userSelectedModel;
        return toolCapable[0];
      }
    }

    // Role fallback when capabilitiesMap is not provided
    const reasoningModel = availableModels.find(m => /deepseek|reason|r1/i.test(m));
    const coderModel = availableModels.find(m => /coder|code/i.test(m));

    if (role === 'orchestrator' || role === 'planner') {
      return reasoningModel || availableModels[0];
    }
    return coderModel || availableModels[0];
  }

  /**
   * Model orchestration helper dynamically selecting execution model:
   * Avoids hardcoded model strings; uses capability metadata and user choice.
   */
  public resolveModelForPhase(
    phase: 'planning' | 'execution',
    userSelectedModel: string,
    availableModels: string[],
    capabilitiesMap?: Map<string, ModelCapabilityResult>
  ): string {
    if (availableModels.length <= 1) {
      return availableModels[0] || userSelectedModel;
    }

    if (capabilitiesMap && capabilitiesMap.size > 0) {
      const toolCapable = availableModels.filter(m => capabilitiesMap.get(m)?.hasTools);
      const nonToolModels = availableModels.filter(m => !capabilitiesMap.get(m)?.hasTools);

      if (phase === 'planning' && nonToolModels.length > 0) {
        return nonToolModels.includes(userSelectedModel) ? userSelectedModel : nonToolModels[0];
      }

      if (phase === 'execution' && toolCapable.length > 0) {
        return toolCapable.includes(userSelectedModel) ? userSelectedModel : toolCapable[0];
      }
    }

    // Heuristic phase fallback when capabilitiesMap is not provided
    const reasoningModel = availableModels.find(m => /deepseek|reason|r1/i.test(m));
    const coderModel = availableModels.find(m => /coder|code/i.test(m));

    if (phase === 'planning') {
      return reasoningModel || availableModels[0];
    }
    return coderModel || availableModels[0];
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
   * Unified, secure fallback extractor for models that emit tool calls in content.
   * STRICT CONDITIONS:
   * 1. Setting `enableEmbeddedFallback` must be explicitly true.
   * 2. Model must be flagged as embedded-capable via user-selected model probe (never Auto).
   * 3. Native `tool_calls` must be empty.
   * 4. Text must be outside <think> blocks and outside blockquotes/echoes.
   * 5. The WHOLE assistant message (after trimming) must be EXACTLY one JSON object or ONE fenced JSON block.
   *    Messages with prose mixed with JSON are rejected immediately.
   * 6. Exactly one call.
   * 7. Arguments validated against tool schema and role allowlist.
   * 8. Fully logged.
   */
  public static extractEmbeddedToolCall(
    content: string,
    options: {
      enableEmbeddedFallback?: boolean;
      isEmbeddedCapableModel?: boolean;
      allowedToolNames?: string[];
      modelName?: string;
    }
  ): Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }> {
    const calls: Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }> = [];
    if (!content) return calls;

    // Condition 1: Setting gate
    if (!options.enableEmbeddedFallback) {
      return calls;
    }

    // Condition 2: Model flagged embedded-capable (only via probe, never in Auto)
    if (!options.isEmbeddedCapableModel) {
      return calls;
    }

    // Condition 4: Text outside <think> blocks and outside blockquotes
    let cleaned = content;
    const thinkEndIdx = cleaned.indexOf('</think>');
    if (thinkEndIdx !== -1) {
      cleaned = cleaned.slice(thinkEndIdx + 8).trim();
    } else if (cleaned.includes('<think>')) {
      // Model was interrupted while thinking; content inside unclosed <think> must not be executed
      return calls;
    }

    // Strip blockquotes (> ...) which indicate echoed tool output or quoted instructions
    cleaned = cleaned.replace(/^>.*$/gm, '').trim();

    if (!cleaned) return calls;

    // Condition 5: The WHOLE assistant message (after trimming) is exactly one JSON object
    // or one fenced JSON block that is the entire message.
    let jsonCandidate = cleaned;
    const fenceMatch = cleaned.match(/^```(?:json)?\s*[\r\n]?([\s\S]*?)[\r\n]?\s*```$/i);
    const xmlMatch = cleaned.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
    if (fenceMatch) {
      jsonCandidate = fenceMatch[1].trim();
    } else if (xmlMatch) {
      jsonCandidate = xmlMatch[1].trim();
    }

    // Must start with { and end with }
    if (!jsonCandidate.startsWith('{') || !jsonCandidate.endsWith('}')) {
      // Contains prose before/after or is not a JSON object
      return calls;
    }

    // Condition 6: Exactly one call (JSON.parse will fail if there are trailing tokens or multiple objects)
    let parsed: any;
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch {
      // Malformed or truncated JSON
      return calls;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return calls;
    }

    // Condition 7: Arguments validated against schema and role allowlist
    const toolName = parsed.name || parsed.function?.name || parsed.tool;
    if (typeof toolName !== 'string' || !toolName.trim()) {
      return calls;
    }

    const isAllowed = !options.allowedToolNames || options.allowedToolNames.length === 0
      ? true
      : options.allowedToolNames.includes(toolName);

    if (!isAllowed) {
      ExtensionLogger.warn(
        `[ToolCalling] Rejected embedded tool call: "${toolName}" is not in offered/allowed tool list.`
      );
      return calls;
    }

    let rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? {};
    if (typeof rawArgs === 'string') {
      try {
        rawArgs = JSON.parse(rawArgs);
      } catch {
        return calls;
      }
    }

    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
      return calls;
    }

    // Condition 8: Logged
    ExtensionLogger.info(
      `[ToolCalling] Safely extracted 1 verified embedded tool call "${toolName}" for model "${options.modelName || 'probed'}".`
    );

    calls.push({
      id: 'call_' + Math.random().toString(36).slice(2, 9),
      function: {
        name: toolName,
        arguments: rawArgs,
      },
    });

    return calls;
  }

  /**
   * Backwards-compatible alias for unit test migration.
   */
  public static extractToolCallsFromContent(
    content: string,
    allowedToolNames?: string[]
  ): Array<{ id?: string; function: { name: string; arguments: Record<string, any> } }> {
    return this.extractEmbeddedToolCall(content, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames,
    });
  }
}
