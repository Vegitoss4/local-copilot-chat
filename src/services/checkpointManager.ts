import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';
import { PathSecurity } from './pathSecurity';

/**
 * Deliverable 11.5: Content-Addressed Local Checkpoints & File Rewind
 * Implements local SHA-256 content-addressed file checkpointing and rewind
 * independent of Git commits, ensuring safe recovery from failed agent turns.
 */

export interface CheckpointFileEntry {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  existedBefore: boolean;
}

export interface CheckpointManifest {
  schemaVersion: '1.0.0';
  checkpointId: string;
  timestamp: string;
  description: string;
  turnId?: string;
  files: CheckpointFileEntry[];
}

export interface CheckpointIndexEntry {
  checkpointId: string;
  timestamp: string;
  description: string;
  fileCount: number;
}

export interface CheckpointIndexData {
  schemaVersion: '1.0.0';
  checkpoints: CheckpointIndexEntry[];
}

export interface RewindResult {
  checkpointId: string;
  restoredFiles: string[];
  deletedCreatedFiles: string[];
  errors: string[];
}

export class CheckpointManager {
  private static _instance: CheckpointManager | undefined;

  public static getInstance(): CheckpointManager {
    if (!this._instance) {
      this._instance = new CheckpointManager();
    }
    return this._instance;
  }

  public getCheckpointsDirUri(targetRootUri?: vscode.Uri): vscode.Uri | null {
    const folder = targetRootUri
      ? WorkspaceManager.getTargetWorkspaceFolder(targetRootUri)
      : WorkspaceManager.getTargetWorkspaceFolder();
    const baseUri = folder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!baseUri) return null;
    return vscode.Uri.joinPath(baseUri, '.vscode', 'local-copilot', 'checkpoints');
  }

  public getBlobsDirUri(targetRootUri?: vscode.Uri): vscode.Uri | null {
    const cpDir = this.getCheckpointsDirUri(targetRootUri);
    if (!cpDir) return null;
    return vscode.Uri.joinPath(cpDir, 'blobs');
  }

  public getIndexFileUri(targetRootUri?: vscode.Uri): vscode.Uri | null {
    const cpDir = this.getCheckpointsDirUri(targetRootUri);
    if (!cpDir) return null;
    return vscode.Uri.joinPath(cpDir, 'checkpoints_index.json');
  }

  public getManifestFileUri(checkpointId: string, targetRootUri?: vscode.Uri): vscode.Uri | null {
    const cpDir = this.getCheckpointsDirUri(targetRootUri);
    if (!cpDir) return null;
    return vscode.Uri.joinPath(cpDir, `${checkpointId}.json`);
  }

  public static computeSha256(data: Uint8Array): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Captures a snapshot of the specified files BEFORE modification occurs.
   */
  public async createCheckpoint(
    description: string,
    relativePaths: string[],
    targetRootUri?: vscode.Uri,
    turnId?: string
  ): Promise<string> {
    const folder = targetRootUri
      ? WorkspaceManager.getTargetWorkspaceFolder(targetRootUri)
      : WorkspaceManager.getTargetWorkspaceFolder();
    const baseUri = folder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!baseUri) {
      throw new Error('Workspace folder required to create checkpoint.');
    }

    const blobsDir = this.getBlobsDirUri(targetRootUri);
    if (!blobsDir) {
      throw new Error('Unable to resolve checkpoint blobs directory.');
    }

    const now = new Date().toISOString();
    const checkpointId = `cp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const fileEntries: CheckpointFileEntry[] = [];

    for (const relPath of relativePaths) {
      const normalizedRel = relPath.replace(/\\/g, '/');
      const fileUri = vscode.Uri.joinPath(baseUri, normalizedRel);

      let existedBefore = false;
      let content: Uint8Array = Buffer.alloc(0);

      try {
        content = await vscode.workspace.fs.readFile(fileUri);
        existedBefore = true;
      } catch {
        // File does not exist yet (will be created in this turn)
        existedBefore = false;
      }

      const sha = existedBefore ? CheckpointManager.computeSha256(content) : 'nonexistent';

      // Store blob if it existed and is not already stored
      if (existedBefore) {
        const blobUri = vscode.Uri.joinPath(blobsDir, sha);
        try {
          const blobExists = await vscode.workspace.fs.stat(blobUri).then(() => true, () => false);
          if (!blobExists) {
            await vscode.workspace.fs.writeFile(blobUri, content);
          }
        } catch {
          await vscode.workspace.fs.writeFile(blobUri, content);
        }
      }

      fileEntries.push({
        relativePath: normalizedRel,
        sha256: sha,
        sizeBytes: content.length,
        existedBefore
      });
    }

    const manifest: CheckpointManifest = {
      schemaVersion: '1.0.0',
      checkpointId,
      timestamp: now,
      description,
      turnId,
      files: fileEntries
    };

    const manifestUri = this.getManifestFileUri(checkpointId, targetRootUri);
    if (manifestUri) {
      await AtomicFileWriter.writeJson(manifestUri, manifest);
      await this._updateIndex(manifest, targetRootUri);
    }

    return checkpointId;
  }

  /**
   * Restores workspace files to their exact state at the given checkpoint.
   */
  public async rewindToCheckpoint(
    checkpointId: string,
    targetRootUri?: vscode.Uri
  ): Promise<RewindResult> {
    const folder = targetRootUri
      ? WorkspaceManager.getTargetWorkspaceFolder(targetRootUri)
      : WorkspaceManager.getTargetWorkspaceFolder();
    const baseUri = folder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!baseUri) {
      throw new Error('Workspace folder required to rewind checkpoint.');
    }

    const manifestUri = this.getManifestFileUri(checkpointId, targetRootUri);
    if (!manifestUri) {
      throw new Error(`Checkpoint manifest not found for ID: ${checkpointId}`);
    }

    const manifest = await AtomicFileWriter.readJson<CheckpointManifest | null>(manifestUri, null);
    if (!manifest) {
      throw new Error(`Failed to read checkpoint manifest for ID: ${checkpointId}`);
    }

    const blobsDir = this.getBlobsDirUri(targetRootUri);
    if (!blobsDir) {
      throw new Error('Blobs directory unresolved.');
    }

    const restoredFiles: string[] = [];
    const deletedCreatedFiles: string[] = [];
    const errors: string[] = [];

    for (const entry of manifest.files) {
      const fileUri = vscode.Uri.joinPath(baseUri, entry.relativePath);

      if (entry.existedBefore) {
        // Restore from blob
        try {
          const blobUri = vscode.Uri.joinPath(blobsDir, entry.sha256);
          const blobBytes = await vscode.workspace.fs.readFile(blobUri);
          await vscode.workspace.fs.writeFile(fileUri, blobBytes);
          restoredFiles.push(entry.relativePath);
        } catch (err: any) {
          errors.push(`Failed to restore ${entry.relativePath}: ${err.message}`);
        }
      } else {
        // File was newly created by agent: delete it to restore pristine pre-turn state
        try {
          await vscode.workspace.fs.delete(fileUri, { useTrash: false });
          deletedCreatedFiles.push(entry.relativePath);
        } catch (err: any) {
          // If already gone, non-critical
        }
      }
    }

    return {
      checkpointId,
      restoredFiles,
      deletedCreatedFiles,
      errors
    };
  }

  /**
   * Lists all available checkpoints recorded in the index.
   */
  public async listCheckpoints(targetRootUri?: vscode.Uri): Promise<CheckpointIndexEntry[]> {
    const indexUri = this.getIndexFileUri(targetRootUri);
    if (!indexUri) return [];

    try {
      const index = await AtomicFileWriter.readJson<CheckpointIndexData>(indexUri, {
        schemaVersion: '1.0.0',
        checkpoints: []
      });
      return index.checkpoints || [];
    } catch {
      return [];
    }
  }

  private async _updateIndex(manifest: CheckpointManifest, targetRootUri?: vscode.Uri): Promise<void> {
    const indexUri = this.getIndexFileUri(targetRootUri);
    if (!indexUri) return;

    try {
      const index = await AtomicFileWriter.readJson<CheckpointIndexData>(indexUri, {
        schemaVersion: '1.0.0',
        checkpoints: []
      });

      const entry: CheckpointIndexEntry = {
        checkpointId: manifest.checkpointId,
        timestamp: manifest.timestamp,
        description: manifest.description,
        fileCount: manifest.files.length
      };

      index.checkpoints.unshift(entry);
      await AtomicFileWriter.writeJson(indexUri, index);
    } catch {}
  }
}
