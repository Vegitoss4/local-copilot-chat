import { AgentRoleV3 } from './whiteboardCoordinator';
import { HardwareCapacityManager } from './hardwareCapacityManager';

export interface DelegationRequest {
  from: AgentRoleV3;
  to: AgentRoleV3;
  task: string;
  context?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface DelegationRecord {
  id: string;
  from: AgentRoleV3;
  to: AgentRoleV3;
  task: string;
  status: 'completed' | 'failed' | 'timed_out';
  attempts: number;
  output?: string;
  error?: string;
  durationMs: number;
  timestamp: number;
}

export class SubagentDelegationProtocol {
  private static readonly DEFAULT_TIMEOUT_MS = 25000;
  private static readonly DEFAULT_RETRIES = 2;

  private _history: DelegationRecord[] = [];

  public getHistory(): ReadonlyArray<DelegationRecord> {
    return [...this._history];
  }

  /**
   * Delegates a subtask to an agent executor with timeout enforcement, retries, and hardware queueing.
   */
  public async delegate(
    request: DelegationRequest,
    executor: (prompt: string, attempt: number, signal: AbortSignal) => Promise<string>,
    model: string = 'qwen2.5-coder:7b'
  ): Promise<string> {
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? SubagentDelegationProtocol.DEFAULT_TIMEOUT_MS;
    const maxRetries = request.maxRetries ?? SubagentDelegationProtocol.DEFAULT_RETRIES;
    const capacityMgr = HardwareCapacityManager.getInstance();

    let lastError: string = '';
    let attempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts = attempt;
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Delegation to ${request.to} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const promptWithContext = attempt === 1
          ? `Task for ${request.to}: ${request.task}\nContext: ${request.context || 'none'}`
          : `Task for ${request.to}: ${request.task}\nPrevious attempt failed with error: ${lastError}\nPlease correct your response.`;

        // Serialize execution through hardware capacity manager
        const runPromise = capacityMgr.enqueueInferenceTurn(model, async () => {
          return executor(promptWithContext, attempt, controller.signal);
        });

        const result = await Promise.race([runPromise, timeoutPromise]);
        clearTimeout(timer);

        this._history.push({
          id: `del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          from: request.from,
          to: request.to,
          task: request.task,
          status: 'completed',
          attempts,
          output: result,
          durationMs: Date.now() - startTime,
          timestamp: Date.now()
        });

        return result;
      } catch (err: any) {
        if (timer) clearTimeout(timer);
        lastError = err?.message || String(err);

        // If timed out or reached max retries, fail
        if (lastError.includes('timed out') || attempt === maxRetries) {
          const isTimeout = lastError.includes('timed out');
          this._history.push({
            id: `del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            from: request.from,
            to: request.to,
            task: request.task,
            status: isTimeout ? 'timed_out' : 'failed',
            attempts,
            error: lastError,
            durationMs: Date.now() - startTime,
            timestamp: Date.now()
          });
          throw new Error(`Subagent delegation to ${request.to} failed: ${lastError}`);
        }
      }
    }

    throw new Error(`Subagent delegation to ${request.to} failed after ${attempts} attempts`);
  }
}
