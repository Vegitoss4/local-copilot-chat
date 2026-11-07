import * as vscode from 'vscode';
import * as path from 'path';

export interface AtomicWriteOptions {
  cleanStaleTempFiles?: boolean; // Default true (cleans .tmp files > 60s old)
  backupCorrupt?: boolean;       // Default true (creates .corrupt on JSON parse failure)
}

export class AtomicFileWriter {
  private static _writeQueues: Map<string, Promise<void>> = new Map();

  /**
   * Generates a unique temporary URI including process.pid, timestamp, and random entropy.
   */
  public static getTempUri(targetUri: vscode.Uri): vscode.Uri {
    const dirUri = vscode.Uri.joinPath(targetUri, '..');
    const baseName = path.basename(targetUri.fsPath);
    const rand = Math.random().toString(36).substring(2, 8);
    const tmpFileName = `${baseName}.tmp.${process.pid}.${Date.now()}.${rand}`;
    return vscode.Uri.joinPath(dirUri, tmpFileName);
  }

  /**
   * Atomically writes data to a target JSON file:
   * 1. Serializes concurrent writes per target file URI using a mutex promise chain.
   * 2. Writes content to a unique temporary file.
   * 3. Atomically replaces target file using vscode.workspace.fs.rename(tmp, target, { overwrite: true }).
   * 4. Cleans up temporary file if write or rename fails.
   */
  public static async writeJson(
    targetUri: vscode.Uri,
    data: any,
    options?: AtomicWriteOptions
  ): Promise<void> {
    const key = targetUri.fsPath.toLowerCase();
    const currentQueue = this._writeQueues.get(key) || Promise.resolve();

    const writeOp = currentQueue.catch(() => {}).then(async () => {
      const dirUri = vscode.Uri.joinPath(targetUri, '..');
      const tmpUri = this.getTempUri(targetUri);

      try {
        await vscode.workspace.fs.createDirectory(dirUri);
        const jsonText = JSON.stringify(data, null, 2);
        const buffer = new TextEncoder().encode(jsonText);

        await vscode.workspace.fs.writeFile(tmpUri, buffer);
        await vscode.workspace.fs.rename(tmpUri, targetUri, { overwrite: true });

        if (options?.cleanStaleTempFiles !== false) {
          await this.cleanupStaleTempFiles(dirUri, path.basename(targetUri.fsPath));
        }
      } catch (err) {
        try {
          await vscode.workspace.fs.delete(tmpUri, { useTrash: false });
        } catch {}
        throw err;
      }
    });

    this._writeQueues.set(key, writeOp.catch(() => {}));
    return writeOp;
  }

  /**
   * Safely reads and parses a JSON file with automatic corruption backup.
   */
  public static async readJson<T>(
    targetUri: vscode.Uri,
    fallback: T,
    options?: AtomicWriteOptions
  ): Promise<T> {
    try {
      const data = await vscode.workspace.fs.readFile(targetUri);
      const text = new TextDecoder('utf-8').decode(data);
      const parsed = JSON.parse(text);
      return parsed as T;
    } catch (err: any) {
      if (err && err.name === 'FileNotFound' || err.code === 'FileNotFound') {
        return fallback;
      }

      // Check if file existed but was malformed
      if (options?.backupCorrupt !== false) {
        try {
          const rawData = await vscode.workspace.fs.readFile(targetUri);
          const dirUri = vscode.Uri.joinPath(targetUri, '..');
          const corruptUri = vscode.Uri.joinPath(dirUri, `${path.basename(targetUri.fsPath)}.corrupt`);
          await vscode.workspace.fs.writeFile(corruptUri, rawData);
        } catch {}
      }

      return fallback;
    }
  }

  /**
   * Scans target directory and removes abandoned temporary files older than threshold (default 60s).
   */
  public static async cleanupStaleTempFiles(
    dirUri: vscode.Uri,
    baseName: string,
    maxAgeMs: number = 60000
  ): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const now = Date.now();
      const prefix = `${baseName}.tmp.`;

      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.startsWith(prefix)) {
          // Parse timestamp from name: ${baseName}.tmp.${pid}.${timestamp}.${rand}
          const parts = name.split('.');
          if (parts.length >= 4) {
            const timestamp = parseInt(parts[parts.length - 2], 10);
            if (!isNaN(timestamp) && (now - timestamp) > maxAgeMs) {
              try {
                const staleUri = vscode.Uri.joinPath(dirUri, name);
                await vscode.workspace.fs.delete(staleUri, { useTrash: false });
              } catch {}
            }
          }
        }
      }
    } catch {}
  }
}
