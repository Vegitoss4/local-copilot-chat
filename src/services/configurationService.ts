import * as vscode from 'vscode';

export type ModelUnloadPolicy = 'keepAlive' | 'unloadImmediately' | 'unloadOnIdle';

export interface ILocalCopilotConfig {
  ollamaEndpoint: string;
  defaultModel: string;
  numCtx: number;
  temperature: number;
  maxTurns: number;
  connectTimeout: number;
  idleStreamTimeout: number;
  totalGenerationTimeout: number;
  modelUnloadPolicy: ModelUnloadPolicy;
  modelKeepAliveDuration: string;
  idleUnloadTimeout: number;
  warnOnCpuOffload: boolean;
  routerEnabled: boolean;
  benchmarkRepetitions: number;
  enableStructuredEditFallback: boolean;
  suggestAgentModeOnEditIntent: boolean;
  minExplorationBeforeAsk: number;
  maxClarificationQuestionsPerTask: number;
  enableWorkspaceDiscoveryPreStep: boolean;
  streamToolCalls: boolean;
  enableEmbeddedToolCallFallback: boolean;
  headersTimeout: number;
}

export const CONFIG_DEFAULTS = {
  ollamaEndpoint: 'http://127.0.0.1:11434',
  defaultModel: 'qwen2.5-coder:7b',
  numCtx: 16384,
  temperature: 0.2,
  maxTurns: 25,
  connectTimeout: 5000,
  headersTimeout: 45000,
  idleStreamTimeout: 30000,
  totalGenerationTimeout: 300000,
  modelUnloadPolicy: 'keepAlive' as ModelUnloadPolicy,
  modelKeepAliveDuration: '5m',
  idleUnloadTimeout: 180000,
  warnOnCpuOffload: true,
  routerEnabled: false,
  benchmarkRepetitions: 3,
  enableStructuredEditFallback: true,
  suggestAgentModeOnEditIntent: true,
  minExplorationBeforeAsk: 3,
  maxClarificationQuestionsPerTask: 2,
  enableWorkspaceDiscoveryPreStep: true,
  streamToolCalls: true,
  enableEmbeddedToolCallFallback: false,
} as const;

export const CONFIG_BOUNDS = {
  numCtx: { min: 2048, max: 65536 },
  temperature: { min: 0.0, max: 1.0 },
  maxTurns: { min: 1, max: 100 },
  connectTimeout: { min: 1000, max: 30000 },
  headersTimeout: { min: 1000, max: 300000 },
  idleStreamTimeout: { min: 5000, max: 120000 },
  totalGenerationTimeout: { min: 30000, max: 900000 },
  idleUnloadTimeout: { min: 30000, max: 600000 },
  minExplorationBeforeAsk: { min: 0, max: 10 },
  maxClarificationQuestionsPerTask: { min: 0, max: 10 },
} as const;

export class ConfigurationService implements vscode.Disposable {
  private static _instance: ConfigurationService | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _cachedEndpoint: string;

  private readonly _onDidChangeEndpoint = new vscode.EventEmitter<string>();
  public readonly onDidChangeEndpoint: vscode.Event<string> = this._onDidChangeEndpoint.event;

  private readonly _onDidChangeConfig = new vscode.EventEmitter<ILocalCopilotConfig>();
  public readonly onDidChangeConfig: vscode.Event<ILocalCopilotConfig> = this._onDidChangeConfig.event;

  private constructor() {
    this._cachedEndpoint = this.ollamaEndpoint;

    const configSubscription = vscode.workspace.onDidChangeConfiguration(
      (e) => this._handleConfigChange(e)
    );
    this._disposables.push(configSubscription, this._onDidChangeEndpoint, this._onDidChangeConfig);
  }

  public static getInstance(): ConfigurationService {
    if (!ConfigurationService._instance) {
      ConfigurationService._instance = new ConfigurationService();
    }
    return ConfigurationService._instance;
  }

  public static resetInstance(): void {
    if (ConfigurationService._instance) {
      ConfigurationService._instance.dispose();
      ConfigurationService._instance = undefined;
    }
  }

  private _handleConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('localCopilot.ollamaEndpoint')) {
      const newEndpoint = this.ollamaEndpoint;
      if (newEndpoint !== this._cachedEndpoint) {
        this._cachedEndpoint = newEndpoint;
        this._onDidChangeEndpoint.fire(newEndpoint);
      }
    }

    if (e.affectsConfiguration('localCopilot')) {
      this._onDidChangeConfig.fire(this.getConfig());
    }
  }

  public get ollamaEndpoint(): string {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<string>('ollamaEndpoint');
    if (typeof raw !== 'string' || !raw.trim()) {
      return CONFIG_DEFAULTS.ollamaEndpoint;
    }

    const trimmed = raw.trim().replace(/\/+$/, '');
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return CONFIG_DEFAULTS.ollamaEndpoint;
      }
      return trimmed;
    } catch {
      return CONFIG_DEFAULTS.ollamaEndpoint;
    }
  }

  public get defaultModel(): string {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<string>('defaultModel');
    if (typeof raw !== 'string' || !raw.trim()) {
      return CONFIG_DEFAULTS.defaultModel;
    }
    return raw.trim();
  }

  public get numCtx(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('numCtx');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.numCtx;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.numCtx.min, Math.min(CONFIG_BOUNDS.numCtx.max, intVal));
  }

  public get temperature(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('temperature');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.temperature;
    }
    return Math.max(CONFIG_BOUNDS.temperature.min, Math.min(CONFIG_BOUNDS.temperature.max, raw));
  }

  public get maxTurns(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('maxTurns');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.maxTurns;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.maxTurns.min, Math.min(CONFIG_BOUNDS.maxTurns.max, intVal));
  }

  public get connectTimeout(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('connectTimeout');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.connectTimeout;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.connectTimeout.min, Math.min(CONFIG_BOUNDS.connectTimeout.max, intVal));
  }

  public get idleStreamTimeout(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('idleStreamTimeout');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.idleStreamTimeout;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.idleStreamTimeout.min, Math.min(CONFIG_BOUNDS.idleStreamTimeout.max, intVal));
  }

  public get totalGenerationTimeout(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('totalGenerationTimeout');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.totalGenerationTimeout;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.totalGenerationTimeout.min, Math.min(CONFIG_BOUNDS.totalGenerationTimeout.max, intVal));
  }

  public get modelUnloadPolicy(): ModelUnloadPolicy {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<string>('modelUnloadPolicy');
    if (raw === 'keepAlive' || raw === 'unloadImmediately' || raw === 'unloadOnIdle') {
      return raw;
    }
    return CONFIG_DEFAULTS.modelUnloadPolicy;
  }

  public get modelKeepAliveDuration(): string {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<string>('modelKeepAliveDuration');
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    return CONFIG_DEFAULTS.modelKeepAliveDuration;
  }

  public get idleUnloadTimeout(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('idleUnloadTimeout');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.idleUnloadTimeout;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.idleUnloadTimeout.min, Math.min(CONFIG_BOUNDS.idleUnloadTimeout.max, intVal));
  }

  public get warnOnCpuOffload(): boolean {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('context.warnOnCpuOffload');
    if (typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.warnOnCpuOffload;
  }

  public get routerEnabled(): boolean {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('router.enabled');
    if (typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.routerEnabled;
  }

  public get benchmarkRepetitions(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('benchmark.repetitions');
    if (typeof raw === 'number' && !isNaN(raw) && raw >= 1 && raw <= 10) {
      return Math.floor(raw);
    }
    return CONFIG_DEFAULTS.benchmarkRepetitions;
  }

  public get enableStructuredEditFallback(): boolean {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('agent.enableStructuredEditFallback');
    if (typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.enableStructuredEditFallback;
  }

  public get suggestAgentModeOnEditIntent(): boolean {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('agent.suggestAgentModeOnEditIntent');
    if (typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.suggestAgentModeOnEditIntent;
  }

  public get minExplorationBeforeAsk(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('agent.minExplorationBeforeAsk');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.minExplorationBeforeAsk;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.minExplorationBeforeAsk.min, Math.min(CONFIG_BOUNDS.minExplorationBeforeAsk.max, intVal));
  }

  public get maxClarificationQuestionsPerTask(): number {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('agent.maxClarificationQuestionsPerTask');
    if (typeof raw !== 'number' || isNaN(raw) || !isFinite(raw)) {
      return CONFIG_DEFAULTS.maxClarificationQuestionsPerTask;
    }
    const intVal = Math.floor(raw);
    return Math.max(CONFIG_BOUNDS.maxClarificationQuestionsPerTask.min, Math.min(CONFIG_BOUNDS.maxClarificationQuestionsPerTask.max, intVal));
  }

  public get enableWorkspaceDiscoveryPreStep(): boolean {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('agent.enableWorkspaceDiscoveryPreStep');
    if (typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.enableWorkspaceDiscoveryPreStep;
  }

  public get streamToolCalls(): boolean {
    const raw = vscode.workspace.getConfiguration('localCopilot').get<any>('tools.stream');
    if (typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.streamToolCalls;
  }

  public get enableEmbeddedToolCallFallback(): boolean {
    const config = vscode.workspace.getConfiguration('localCopilot');
    const inspection = typeof config.inspect === 'function'
      ? config.inspect<boolean>('tools.enableEmbeddedFallback')
      : undefined;
    // User-scoped safety enforcement: workspace-level settings are strictly ignored.
    // Only globalValue (User/application setting) is honored.
    if (inspection && typeof inspection.globalValue === 'boolean') {
      return inspection.globalValue;
    }
    const raw = config.get<any>('tools.enableEmbeddedFallback');
    if (!inspection && typeof raw === 'boolean') {
      return raw;
    }
    return CONFIG_DEFAULTS.enableEmbeddedToolCallFallback;
  }

  public get headersTimeout(): number {
    const config = vscode.workspace.getConfiguration('localCopilot');
    const raw = config.get<any>('timeouts.headersTimeoutMs');
    if (typeof raw === 'number' && !isNaN(raw) && isFinite(raw)) {
      const intVal = Math.floor(raw);
      return Math.max(CONFIG_BOUNDS.headersTimeout.min, Math.min(CONFIG_BOUNDS.headersTimeout.max, intVal));
    }
    // Deprecated legacy setting fallback: localCopilot.headersTimeout
    const legacy = config.get<any>('headersTimeout');
    if (typeof legacy === 'number' && !isNaN(legacy) && isFinite(legacy)) {
      const intVal = Math.floor(legacy);
      return Math.max(CONFIG_BOUNDS.headersTimeout.min, Math.min(CONFIG_BOUNDS.headersTimeout.max, intVal));
    }
    return CONFIG_DEFAULTS.headersTimeout;
  }

  public getConfig(): ILocalCopilotConfig {
    return {
      ollamaEndpoint: this.ollamaEndpoint,
      defaultModel: this.defaultModel,
      numCtx: this.numCtx,
      temperature: this.temperature,
      maxTurns: this.maxTurns,
      connectTimeout: this.connectTimeout,
      idleStreamTimeout: this.idleStreamTimeout,
      totalGenerationTimeout: this.totalGenerationTimeout,
      modelUnloadPolicy: this.modelUnloadPolicy,
      modelKeepAliveDuration: this.modelKeepAliveDuration,
      idleUnloadTimeout: this.idleUnloadTimeout,
      warnOnCpuOffload: this.warnOnCpuOffload,
      routerEnabled: this.routerEnabled,
      benchmarkRepetitions: this.benchmarkRepetitions,
      enableStructuredEditFallback: this.enableStructuredEditFallback,
      suggestAgentModeOnEditIntent: this.suggestAgentModeOnEditIntent,
      minExplorationBeforeAsk: this.minExplorationBeforeAsk,
      maxClarificationQuestionsPerTask: this.maxClarificationQuestionsPerTask,
      enableWorkspaceDiscoveryPreStep: this.enableWorkspaceDiscoveryPreStep,
      streamToolCalls: this.streamToolCalls,
      enableEmbeddedToolCallFallback: this.enableEmbeddedToolCallFallback,
      headersTimeout: this.headersTimeout,
    };
  }

  public dispose(): void {
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {}
    }
    this._disposables = [];
  }
}
