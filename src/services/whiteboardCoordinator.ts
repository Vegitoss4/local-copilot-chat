import * as vscode from 'vscode';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';

export type AgentRoleV3 = 'orchestrator' | 'architect' | 'developer' | 'tester' | 'reviewer' | 'security';

export interface AgentSubtask {
  id: string;
  assignedTo: AgentRoleV3;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependsOn?: string[];
  output?: string;
  error?: string;
}

export interface WhiteboardStateV3 {
  version: 3;
  activeTaskId: string;
  userObjective: string;
  executionPlan: string;
  scratchpad: string;
  modifiedFiles: string[];
  diagnostics: string[];
  activeLeases: Record<string, string>; // filePath -> holderAgentRole
  subtasks: AgentSubtask[];
  consensusRecords: Array<{
    targetAction: string;
    approvals: AgentRoleV3[];
    rejections: AgentRoleV3[];
    decision: 'APPROVED' | 'REJECTED' | 'PENDING';
    timestamp: number;
  }>;
  checkpoints: Array<{
    id: string;
    timestamp: number;
    description: string;
    modifiedFilesSnapshot: string[];
  }>;
  updatedAt: number;
}

export class WhiteboardCoordinator {
  private static readonly STORAGE_FILE = 'whiteboard-v3.json';
  private static _instance: WhiteboardCoordinator | undefined;

  private _state: WhiteboardStateV3;

  constructor(initialObjective: string = '') {
    this._state = {
      version: 3,
      activeTaskId: `task_${Date.now()}`,
      userObjective: initialObjective,
      executionPlan: '',
      scratchpad: '',
      modifiedFiles: [],
      diagnostics: [],
      activeLeases: {},
      subtasks: [],
      consensusRecords: [],
      checkpoints: [],
      updatedAt: Date.now()
    };
  }

  public static getInstance(): WhiteboardCoordinator {
    if (!this._instance) {
      this._instance = new WhiteboardCoordinator();
    }
    return this._instance;
  }

  public static resetInstance(): void {
    this._instance = undefined;
  }

  public getState(): Readonly<WhiteboardStateV3> {
    return JSON.parse(JSON.stringify(this._state));
  }

  public initTask(objective: string): void {
    this._state.activeTaskId = `task_${Date.now()}`;
    this._state.userObjective = objective;
    this._state.executionPlan = '';
    this._state.scratchpad = '';
    this._state.modifiedFiles = [];
    this._state.diagnostics = [];
    this._state.activeLeases = {};
    this._state.subtasks = [];
    this._state.consensusRecords = [];
    this._state.checkpoints = [];
    this._state.updatedAt = Date.now();
  }

  public updatePlan(plan: string): void {
    this._state.executionPlan = plan;
    this._state.updatedAt = Date.now();
  }

  public appendScratchpad(note: string, author?: AgentRoleV3): void {
    const prefix = author ? `[${author.toUpperCase()}]: ` : '';
    this._state.scratchpad += `\n${prefix}${note}`;
    this._state.updatedAt = Date.now();
  }

  public recordModifiedFile(filePath: string): void {
    if (!this._state.modifiedFiles.includes(filePath)) {
      this._state.modifiedFiles.push(filePath);
      this._state.updatedAt = Date.now();
    }
  }

  public addSubtask(subtask: AgentSubtask): void {
    this._state.subtasks.push(subtask);
    this._state.updatedAt = Date.now();
  }

  public updateSubtaskStatus(subtaskId: string, status: AgentSubtask['status'], output?: string, error?: string): void {
    const found = this._state.subtasks.find(s => s.id === subtaskId);
    if (found) {
      found.status = status;
      if (output !== undefined) found.output = output;
      if (error !== undefined) found.error = error;
      this._state.updatedAt = Date.now();
    }
  }

  public createCheckpoint(description: string): string {
    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this._state.checkpoints.push({
      id: checkpointId,
      timestamp: Date.now(),
      description,
      modifiedFilesSnapshot: [...this._state.modifiedFiles]
    });
    this._state.updatedAt = Date.now();
    return checkpointId;
  }

  public rollbackToCheckpoint(checkpointId: string): boolean {
    const cp = this._state.checkpoints.find(c => c.id === checkpointId);
    if (!cp) return false;

    this._state.modifiedFiles = [...cp.modifiedFilesSnapshot];
    this.appendScratchpad(`Rolled back state to checkpoint: ${cp.description} (${checkpointId})`);
    this._state.updatedAt = Date.now();
    return true;
  }

  /**
   * Persists whiteboard state atomically to workspace storage.
   */
  public async persistState(targetFolderUri?: vscode.Uri): Promise<void> {
    const folder = WorkspaceManager.getTargetWorkspaceFolder(targetFolderUri);
    if (!folder) return;

    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'local-copilot', WhiteboardCoordinator.STORAGE_FILE);
    await AtomicFileWriter.writeJson(uri, this._state);
  }

  /**
   * Loads whiteboard state atomically from workspace storage.
   */
  public async loadState(targetFolderUri?: vscode.Uri): Promise<boolean> {
    const folder = WorkspaceManager.getTargetWorkspaceFolder(targetFolderUri);
    if (!folder) return false;

    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'local-copilot', WhiteboardCoordinator.STORAGE_FILE);
    const loaded = await AtomicFileWriter.readJson<WhiteboardStateV3 | null>(uri, null);
    if (loaded && loaded.version === 3) {
      this._state = loaded;
      return true;
    }
    return false;
  }
}
