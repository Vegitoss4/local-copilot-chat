/**
 * Deliverable 10.0: Hardware Capacity Budget & Multi-Agent Planning for Local 8 GB VRAM.
 * Calibrated specifically for single-GPU 8 GB VRAM constraints on Windows 11.
 * Enforces serialized LLM inference turns while allowing overlapping background tool execution.
 */

export interface HardwareBudgetConfig {
  maxVramBytes: number; // default 8 GB (8 * 1024 * 1024 * 1024)
  reservedVramBytes: number; // default 1.5 GB for OS/Desktop
  maxConcurrentToolTasks: number; // default 2
  singleModelResidencyEnforced: boolean; // strictly true for 8 GB
}

export interface InferenceTurnQueueStats {
  queuedCount: number;
  activeTurnModel: string | null;
  totalCompletedTurns: number;
  activeToolTasksCount: number;
}

export class HardwareCapacityManager {
  private static _instance: HardwareCapacityManager | undefined;

  public static readonly DEFAULT_8GB_VRAM = 8 * 1024 * 1024 * 1024;
  public static readonly DEFAULT_RESERVED_VRAM = 1.5 * 1024 * 1024 * 1024;

  private _config: HardwareBudgetConfig;
  private _inferenceQueue: Array<() => Promise<void>> = [];
  private _isInferenceActive: boolean = false;
  private _activeModel: string | null = null;
  private _activeToolTasks: number = 0;
  private _totalCompletedTurns: number = 0;

  constructor(config?: Partial<HardwareBudgetConfig>) {
    this._config = {
      maxVramBytes: config?.maxVramBytes ?? HardwareCapacityManager.DEFAULT_8GB_VRAM,
      reservedVramBytes: config?.reservedVramBytes ?? HardwareCapacityManager.DEFAULT_RESERVED_VRAM,
      maxConcurrentToolTasks: config?.maxConcurrentToolTasks ?? 2,
      singleModelResidencyEnforced: true // Always enforced on 8 GB
    };
  }

  public static getInstance(): HardwareCapacityManager {
    if (!this._instance) {
      this._instance = new HardwareCapacityManager();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  public getConfig(): Readonly<HardwareBudgetConfig> {
    return { ...this._config };
  }

  public getStats(): InferenceTurnQueueStats {
    return {
      queuedCount: this._inferenceQueue.length,
      activeTurnModel: this._activeModel,
      totalCompletedTurns: this._totalCompletedTurns,
      activeToolTasksCount: this._activeToolTasks
    };
  }

  /**
   * Enqueues an LLM inference turn into the serialized execution queue.
   * On 8 GB VRAM, concurrent inference against Ollama leads to KV-cache thrashing or OOM.
   */
  public async enqueueInferenceTurn<T>(model: string, turnFn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const executeTurn = async () => {
        this._isInferenceActive = true;
        this._activeModel = model;
        try {
          const result = await turnFn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this._isInferenceActive = false;
          this._activeModel = null;
          this._totalCompletedTurns++;
          this._pumpQueue();
        }
      };

      this._inferenceQueue.push(executeTurn);
      if (!this._isInferenceActive) {
        this._pumpQueue();
      }
    });
  }

  /**
   * Checks if an asynchronous non-LLM tool task (e.g. build check, unit test, file scan)
   * can be scheduled concurrently.
   */
  public canScheduleToolTask(): boolean {
    return this._activeToolTasks < this._config.maxConcurrentToolTasks;
  }

  /**
   * Acquires a slot for a background tool task.
   */
  public acquireToolSlot(): boolean {
    if (this.canScheduleToolTask()) {
      this._activeToolTasks++;
      return true;
    }
    return false;
  }

  /**
   * Releases a background tool task slot.
   */
  public releaseToolSlot(): void {
    if (this._activeToolTasks > 0) {
      this._activeToolTasks--;
    }
  }

  private _pumpQueue(): void {
    if (this._isInferenceActive || this._inferenceQueue.length === 0) {
      return;
    }
    const nextTurn = this._inferenceQueue.shift();
    if (nextTurn) {
      nextTurn();
    }
  }
}
