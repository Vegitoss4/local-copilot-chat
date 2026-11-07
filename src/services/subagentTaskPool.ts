export type TaskPriority = 'high' | 'normal' | 'low';

export interface PoolTask<T = any> {
  id: string;
  name: string;
  priority: TaskPriority;
  execute: (signal?: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
}

export interface TaskPoolStats {
  activeCount: number;
  queuedCount: number;
  completedCount: number;
  failedCount: number;
}

export class SubagentTaskPool {
  private static readonly DEFAULT_MAX_CONCURRENCY = 2;

  private _maxConcurrency: number;
  private _activeCount: number = 0;
  private _completedCount: number = 0;
  private _failedCount: number = 0;

  private _highQueue: Array<{ task: PoolTask; resolve: (val: any) => void; reject: (err: any) => void }> = [];
  private _normalQueue: Array<{ task: PoolTask; resolve: (val: any) => void; reject: (err: any) => void }> = [];
  private _lowQueue: Array<{ task: PoolTask; resolve: (val: any) => void; reject: (err: any) => void }> = [];

  constructor(maxConcurrency: number = SubagentTaskPool.DEFAULT_MAX_CONCURRENCY) {
    this._maxConcurrency = Math.max(1, maxConcurrency);
  }

  public getStats(): TaskPoolStats {
    return {
      activeCount: this._activeCount,
      queuedCount: this._highQueue.length + this._normalQueue.length + this._lowQueue.length,
      completedCount: this._completedCount,
      failedCount: this._failedCount
    };
  }

  /**
   * Submits an asynchronous background tool task to the concurrency-capped pool.
   */
  public async submit<T>(task: PoolTask<T>): Promise<T> {
    if (task.signal?.aborted) {
      throw new Error(`Task ${task.name} (${task.id}) aborted before starting`);
    }

    return new Promise<T>((resolve, reject) => {
      const item = { task, resolve, reject };

      if (task.priority === 'high') {
        this._highQueue.push(item);
      } else if (task.priority === 'low') {
        this._lowQueue.push(item);
      } else {
        this._normalQueue.push(item);
      }

      this._pump();
    });
  }

  private _pump(): void {
    while (this._activeCount < this._maxConcurrency) {
      const next = this._dequeueNext();
      if (!next) break;

      const { task, resolve, reject } = next;

      if (task.signal?.aborted) {
        this._failedCount++;
        reject(new Error(`Task ${task.name} aborted`));
        continue;
      }

      this._activeCount++;

      task.execute(task.signal)
        .then(result => {
          this._completedCount++;
          resolve(result);
        })
        .catch(err => {
          this._failedCount++;
          reject(err);
        })
        .finally(() => {
          this._activeCount--;
          this._pump();
        });
    }
  }

  private _dequeueNext() {
    if (this._highQueue.length > 0) return this._highQueue.shift();
    if (this._normalQueue.length > 0) return this._normalQueue.shift();
    if (this._lowQueue.length > 0) return this._lowQueue.shift();
    return undefined;
  }
}
