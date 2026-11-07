import { OllamaService, IOllamaModelInfo } from './ollamaService';
import { ConfigurationService, ModelUnloadPolicy } from './configurationService';

export interface ModelSwitchOptions {
  aggressiveUnload?: boolean;
  forceUnloadUnknown?: boolean;
}

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: any): Thenable<void> | Promise<void>;
}

export class ModelLifecycleManager {
  private static _instance: ModelLifecycleManager | undefined;
  private _ollamaService: OllamaService;
  private _configService: ConfigurationService;
  private _memento?: MementoLike;
  private _activeGenerations: number = 0;
  private _lastActiveModel: string | undefined;
  private _extensionOwnedModels: Set<string> = new Set();
  private _idleUnloadTimer: NodeJS.Timeout | undefined;
  private _operationMutex: Promise<any> = Promise.resolve();
  public idleUnloadTimeoutMs?: number;

  constructor(
    ollamaService: OllamaService,
    configService: ConfigurationService,
    memento?: MementoLike
  ) {
    this._ollamaService = ollamaService;
    this._configService = configService;
    if (memento) {
      this.setMemento(memento);
    }
  }

  public setMemento(memento: MementoLike): void {
    this._memento = memento;
    try {
      const saved = this._memento.get<string[]>('localCopilot.ownedModels', []);
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (typeof item === 'string' && item.trim()) {
            this._extensionOwnedModels.add(item.trim());
          }
        }
      }
    } catch {
      // Best-effort state restoration
    }
  }

  private _persistOwnership(): void {
    if (this._memento) {
      try {
        this._memento.update('localCopilot.ownedModels', Array.from(this._extensionOwnedModels));
      } catch {
        // Non-blocking
      }
    }
  }

  public registerModelOwnership(model: string): void {
    if (model && model.trim()) {
      this._extensionOwnedModels.add(model.trim());
      this._persistOwnership();
    }
  }

  public isModelOwned(model: string): boolean {
    return this._extensionOwnedModels.has(model.trim());
  }

  public getExtensionOwnedModels(): string[] {
    return Array.from(this._extensionOwnedModels);
  }

  public static getInstance(
    ollamaService?: OllamaService,
    configService?: ConfigurationService,
    memento?: MementoLike
  ): ModelLifecycleManager {
    if (!ModelLifecycleManager._instance) {
      const ollama = ollamaService || new OllamaService();
      const config = configService || ConfigurationService.getInstance();
      ModelLifecycleManager._instance = new ModelLifecycleManager(ollama, config, memento);
    } else if (memento && !ModelLifecycleManager._instance._memento) {
      ModelLifecycleManager._instance.setMemento(memento);
    }
    return ModelLifecycleManager._instance;
  }

  public static resetInstance(): void {
    if (ModelLifecycleManager._instance) {
      ModelLifecycleManager._instance.dispose();
      ModelLifecycleManager._instance = undefined;
    }
  }

  public get isGenerationActive(): boolean {
    return this._activeGenerations > 0;
  }

  public get lastActiveModel(): string | undefined {
    return this._lastActiveModel;
  }

  /**
   * Returns list of currently resident models directly from Ollama via GET /api/ps.
   * Ground-truth observability; does not make false assumptions about host VRAM.
   */
  public async getLoadedModels(): Promise<IOllamaModelInfo[]> {
    return await this._ollamaService.getLoadedModels();
  }

  /**
   * Safe model switching coordinator under 8 GB VRAM constraints:
   * Serializes switching operations, verifies generation is not active,
   * unloads previous model if requested to release VRAM before target model loads.
   */
  public async switchModel(targetModel: string, options: ModelSwitchOptions = {}): Promise<boolean> {
    if (!targetModel || !targetModel.trim()) return false;
    const target = targetModel.trim();

    return this._enqueueOperation(async () => {
      if (this.isGenerationActive) {
        throw new Error(`Cannot switch model: generation turn is currently active.`);
      }

      this._disarmIdleTimer();

      // Check currently loaded models
      const loaded = await this.getLoadedModels();
      const isTargetLoaded = loaded.some(m => m.name === target || m.model === target);

      // Under 8 GB budget, unload non-target resident models that this extension owns.
      // NEVER blindly unload models loaded by external processes or other applications.
      const shouldUnload = options.aggressiveUnload ?? (this._configService.modelUnloadPolicy !== 'keepAlive');
      if (shouldUnload && loaded.length > 0) {
        for (const loadedModel of loaded) {
          const name = loadedModel.name || loadedModel.model;
          if (name && name !== target) {
            const isOwned = this._extensionOwnedModels.has(name);
            // Only unload if model was loaded by this extension, or if caller explicitly requested aggressiveUnload/forceUnloadUnknown
            if (isOwned || options.aggressiveUnload || options.forceUnloadUnknown) {
              await this._ollamaService.unloadModel(name);
              this._extensionOwnedModels.delete(name);
            } else {
              console.warn(
                `[ModelLifecycleManager] Resident model "${name}" was not loaded by this extension. Preserving external model to prevent multi-client disruption.`
              );
            }
          }
        }
      }

      this._extensionOwnedModels.add(target);
      this._lastActiveModel = target;
      this._persistOwnership();
      return true;
    });
  }

  /**
   * Marks start of a generation turn.
   * Disarms idle timers and increments active generation counter.
   */
  public notifyGenerationStart(model: string): void {
    this._disarmIdleTimer();
    this._activeGenerations++;
    const clean = model ? model.trim() : '';
    if (clean) {
      this._extensionOwnedModels.add(clean);
      this._lastActiveModel = clean;
      this._persistOwnership();
    }
  }

  /**
   * Marks end of a generation turn.
   * Enforces configured model unload policy:
   * - unloadImmediately: Unloads model right away via keep_alive: 0
   * - unloadOnIdle: Arms sliding idle unload timer
   * - keepAlive: Relies on Ollama native keep_alive duration
   */
  public async notifyGenerationEnd(model: string): Promise<void> {
    this._activeGenerations = Math.max(0, this._activeGenerations - 1);
    this._lastActiveModel = model;

    if (this._activeGenerations === 0) {
      const policy = this._configService.modelUnloadPolicy;
      if (policy === 'unloadImmediately') {
        await this.unloadCurrentModel();
      } else if (policy === 'unloadOnIdle') {
        this._armIdleTimer(model);
      }
    }
  }

  /**
   * Safely unloads current resident model from GPU VRAM.
   * Fails closed if generation turn is active.
   */
  public async unloadCurrentModel(): Promise<boolean> {
    return this._enqueueOperation(async () => {
      if (this.isGenerationActive) {
        console.warn('[ModelLifecycleManager] Cannot unload model: generation is currently active.');
        return false;
      }

      this._disarmIdleTimer();
      const modelToUnload = this._lastActiveModel;
      if (!modelToUnload) {
        const loaded = await this.getLoadedModels();
        if (loaded.length === 0) return true;
        let success = true;
        for (const m of loaded) {
          const name = m.name || m.model;
          if (name && this._extensionOwnedModels.has(name)) {
            const res = await this._ollamaService.unloadModel(name);
            if (!res) success = false;
            this._extensionOwnedModels.delete(name);
          }
        }
        this._persistOwnership();
        return success;
      }

      const res = await this._ollamaService.unloadModel(modelToUnload);
      this._extensionOwnedModels.delete(modelToUnload);
      this._persistOwnership();
      return res;
    });
  }

  private _enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this._operationMutex.then(operation, operation);
    this._operationMutex = next.catch(() => {});
    return next;
  }

  private _armIdleTimer(model: string): void {
    this._disarmIdleTimer();
    const timeoutMs = this.idleUnloadTimeoutMs ?? this._configService.idleUnloadTimeout;
    this._idleUnloadTimer = setTimeout(async () => {
      try {
        if (!this.isGenerationActive) {
          await this._enqueueOperation(async () => {
            if (!this.isGenerationActive) {
              await this._ollamaService.unloadModel(model);
            }
          });
        }
      } catch (err) {
        console.warn('[ModelLifecycleManager] Idle unload failed:', err);
      }
    }, timeoutMs);
  }

  private _disarmIdleTimer(): void {
    if (this._idleUnloadTimer) {
      clearTimeout(this._idleUnloadTimer);
      this._idleUnloadTimer = undefined;
    }
  }

  public dispose(): void {
    this._disarmIdleTimer();
  }
}
