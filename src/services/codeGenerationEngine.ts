import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { PathSecurity, WorkspaceSecurityError } from './pathSecurity';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';
import { stripMarkdownFences, assertNoFenceLines } from './fenceSanitizer';

export interface FilePatchOperation {
  filePath: string;
  type: 'create' | 'modify' | 'delete';
  content?: string;             // For create or full rewrite
  oldString?: string;           // For surgical str_replace
  newString?: string;           // For surgical str_replace
}

export interface TransactionalEditResult {
  success: boolean;
  appliedOperations: number;
  rolledBack: boolean;
  error?: string;
  modifiedFiles: string[];
  conflicts?: string[];
}

export interface TransactionJournalEntry {
  uriString: string;
  normPath: string;
  initialExists: boolean;
  initialContentBase64?: string;
  lastWrittenHash?: string;
}

export interface TransactionJournal {
  txId: string;
  timestamp: number;
  entries: TransactionJournalEntry[];
}

interface FileSnapshot {
  validatedUri: vscode.Uri;
  normPath: string;
  initialExists: boolean;
  initialContent?: Uint8Array;
  initialHash?: string;
  lastWrittenHash?: string;
}

export class CodeGenerationEngine {
  public static readonly JOURNAL_FILENAME = 'tx-journal.json';
  private _pinnedRoot?: vscode.WorkspaceFolder | vscode.Uri;

  constructor(pinnedRoot?: vscode.WorkspaceFolder | vscode.Uri) {
    this._pinnedRoot = pinnedRoot;
  }

  public get pinnedRoot(): vscode.WorkspaceFolder | vscode.Uri | undefined {
    return this._pinnedRoot;
  }

  public setPinnedRoot(root: vscode.WorkspaceFolder | vscode.Uri): void {
    this._pinnedRoot = root;
  }

  private _hash(content: Uint8Array): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private _getJournalUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(WorkspaceManager.getStorageUri(folder), CodeGenerationEngine.JOURNAL_FILENAME);
  }

  /**
   * Applies an array of file patch operations transactionally.
   * Confines all operations to the pinned workspace root via PathSecurity.
   * If any operation fails, rolls back modified/created files using conflict-aware ownership checks.
   */
  public async applyTransactionalPatches(
    operations: FilePatchOperation[],
    postVerificationHook?: () => Promise<{ valid: boolean; error?: string }>
  ): Promise<TransactionalEditResult> {
    const backupSnapshots = new Map<string, FileSnapshot>();
    const modifiedFiles: string[] = [];
    const conflicts: string[] = [];
    const txId = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    let journalUri: vscode.Uri | undefined;

    try {
      // Step 1: Pre-flight path validation, dirty editor check & snapshotting
      for (const op of operations) {
        const validated = PathSecurity.validatePath(
          op.filePath,
          this._pinnedRoot,
          { allowNewFile: op.type === 'create' }
        );

        if (!journalUri) {
          journalUri = this._getJournalUri(validated.folder);
        }

        // Check for unsaved dirty editor buffers
        const openDoc = vscode.workspace.textDocuments?.find(
          (d) => d.uri.toString() === validated.uri.toString() && d.isDirty
        );
        if (openDoc) {
          throw new Error(
            `Cannot patch "${path.basename(op.filePath)}": file has unsaved editor modifications. Please save or revert tab first.`
          );
        }

        const normPath = path.normalize(validated.uri.fsPath);
        if (!backupSnapshots.has(normPath)) {
          try {
            const data = await vscode.workspace.fs.readFile(validated.uri);
            backupSnapshots.set(normPath, {
              validatedUri: validated.uri,
              normPath,
              initialExists: true,
              initialContent: data,
              initialHash: this._hash(data)
            });
          } catch {
            backupSnapshots.set(normPath, {
              validatedUri: validated.uri,
              normPath,
              initialExists: false
            });
          }
        }
      }

      // Step 2: Write on-disk write-ahead journal before modifying filesystem
      if (journalUri) {
        const journalEntries: TransactionJournalEntry[] = Array.from(backupSnapshots.values()).map((s) => ({
          uriString: s.validatedUri.toString(),
          normPath: s.normPath,
          initialExists: s.initialExists,
          initialContentBase64: s.initialContent ? Buffer.from(s.initialContent).toString('base64') : undefined
        }));
        const journal: TransactionJournal = {
          txId,
          timestamp: Date.now(),
          entries: journalEntries
        };
        await AtomicFileWriter.writeJson(journalUri, journal);
      }

      // Step 3: Apply operations sequentially with two-phase hash verification & line ending normalization
      for (const op of operations) {
        // Re-validate immediately before operation to mitigate TOCTOU
        const validated = PathSecurity.validatePath(
          op.filePath,
          this._pinnedRoot,
          { allowNewFile: op.type === 'create' }
        );
        const normPath = path.normalize(validated.uri.fsPath);
        const snap = backupSnapshots.get(normPath)!;

        // Two-phase hash validation for existing files: detect concurrent external edits
        if (snap.initialExists && op.type !== 'create') {
          let currentBytes: Uint8Array | undefined;
          try {
            currentBytes = await vscode.workspace.fs.readFile(validated.uri);
          } catch {
            currentBytes = undefined;
          }
          const expectedHash = snap.lastWrittenHash || snap.initialHash;
          if (!currentBytes || this._hash(currentBytes) !== expectedHash) {
            throw new Error(
              `Conflict detected: "${path.basename(op.filePath)}" was modified externally between planning and application.`
            );
          }
        }

        if (op.type === 'create') {
          if (op.content === undefined) {
            throw new Error(`Create operation for "${op.filePath}" missing content`);
          }
          const { sanitized } = stripMarkdownFences(op.content, op.filePath);
          assertNoFenceLines(sanitized, op.filePath);
          const buffer = new TextEncoder().encode(sanitized);
          await vscode.workspace.fs.writeFile(validated.uri, buffer);
          snap.lastWrittenHash = this._hash(buffer);
          if (!modifiedFiles.includes(normPath)) modifiedFiles.push(normPath);
        } else if (op.type === 'delete') {
          await vscode.workspace.fs.delete(validated.uri, { useTrash: false });
          snap.lastWrittenHash = undefined;
          if (!modifiedFiles.includes(normPath)) modifiedFiles.push(normPath);
        } else if (op.type === 'modify') {
          if (op.content !== undefined) {
            const { sanitized } = stripMarkdownFences(op.content, op.filePath);
            assertNoFenceLines(sanitized, op.filePath);
            const buffer = new TextEncoder().encode(sanitized);
            await vscode.workspace.fs.writeFile(validated.uri, buffer);
            snap.lastWrittenHash = this._hash(buffer);
            if (!modifiedFiles.includes(normPath)) modifiedFiles.push(normPath);
          } else if (op.oldString !== undefined && op.newString !== undefined) {
            const rawData = await vscode.workspace.fs.readFile(validated.uri);
            let currentText = new TextDecoder('utf-8').decode(rawData);

            // BOM detection & preservation
            const hasBom = currentText.charCodeAt(0) === 0xfeff;
            if (hasBom) {
              currentText = currentText.slice(1);
            }

            // CRLF vs LF detection
            const isCrlf = currentText.includes('\r\n');
            const docLineEnding = isCrlf ? '\r\n' : '\n';

            // Line-ending agnostic search matching
            const normalizedOld = op.oldString.replace(/\r\n|\r|\n/g, docLineEnding);
            const normalizedNew = op.newString.replace(/\r\n|\r|\n/g, docLineEnding);

            const occurrences = currentText.split(normalizedOld).length - 1;
            if (occurrences === 0) {
              const firstLine = op.oldString.split(/\r?\n/)[0]?.trim() || '';
              throw new Error(
                `Surgical replacement failed: target string not found in "${path.basename(op.filePath)}". Hint: search line "${firstLine}" was not matched.`
              );
            }
            if (occurrences > 1) {
              throw new Error(
                `Surgical replacement failed: target string appears ${occurrences} times in "${path.basename(op.filePath)}"; ambiguous match.`
              );
            }

            let updatedText = currentText.replace(normalizedOld, normalizedNew);
            if (hasBom) {
              updatedText = '\uFEFF' + updatedText;
            }
            const buffer = new TextEncoder().encode(updatedText);
            await vscode.workspace.fs.writeFile(validated.uri, buffer);
            snap.lastWrittenHash = this._hash(buffer);
            if (!modifiedFiles.includes(normPath)) modifiedFiles.push(normPath);
          } else {
            throw new Error(`Modify operation for "${op.filePath}" requires either content or (oldString and newString)`);
          }
        }
      }

      // Step 4: Run post-verification hook if provided
      if (postVerificationHook) {
        const check = await postVerificationHook();
        if (!check.valid) {
          throw new Error(`Post-verification hook failed: ${check.error || 'Syntax or validation error'}`);
        }
      }

      // Step 5: Transaction succeeded — remove on-disk journal
      if (journalUri) {
        try {
          await vscode.workspace.fs.delete(journalUri, { useTrash: false });
        } catch {}
      }

      return {
        success: true,
        appliedOperations: operations.length,
        rolledBack: false,
        modifiedFiles
      };
    } catch (err: any) {
      // Conflict-aware rollback of all touched files
      const rollbackResult = await this._rollback(backupSnapshots);
      conflicts.push(...rollbackResult.conflicts);

      // Clean up journal after rollback
      if (journalUri) {
        try {
          await vscode.workspace.fs.delete(journalUri, { useTrash: false });
        } catch {}
      }

      return {
        success: false,
        appliedOperations: 0,
        rolledBack: true,
        error: err?.message || String(err),
        modifiedFiles: [],
        conflicts: conflicts.length > 0 ? conflicts : undefined
      };
    }
  }

  /**
   * Recovers and rolls back an incomplete transaction after an unhandled process termination or crash.
   */
  public static async recoverInterruptedTransaction(
    targetRootUri?: vscode.Uri
  ): Promise<{ recovered: boolean; filesRolledBack: string[] }> {
    const folder = WorkspaceManager.getTargetWorkspaceFolder(targetRootUri);
    if (!folder) return { recovered: false, filesRolledBack: [] };

    const journalUri = vscode.Uri.joinPath(
      WorkspaceManager.getStorageUri(folder),
      CodeGenerationEngine.JOURNAL_FILENAME
    );

    const journal = await AtomicFileWriter.readJson<TransactionJournal | null>(journalUri, null);
    if (!journal || !Array.isArray(journal.entries) || journal.entries.length === 0) {
      return { recovered: false, filesRolledBack: [] };
    }

    const filesRolledBack: string[] = [];
    for (const entry of journal.entries) {
      try {
        const uri = vscode.Uri.parse(entry.uriString);
        if (entry.initialExists && entry.initialContentBase64) {
          const content = Buffer.from(entry.initialContentBase64, 'base64');
          await vscode.workspace.fs.writeFile(uri, content);
          filesRolledBack.push(entry.normPath);
        } else if (!entry.initialExists) {
          try {
            await vscode.workspace.fs.delete(uri, { useTrash: false });
            filesRolledBack.push(entry.normPath);
          } catch {}
        }
      } catch (err) {
        console.error(`[CodeGenerationEngine] Recovery failed for ${entry.normPath}:`, err);
      }
    }

    // Clean up journal
    try {
      await vscode.workspace.fs.delete(journalUri, { useTrash: false });
    } catch {}

    return { recovered: true, filesRolledBack };
  }

  /**
   * Conflict-aware rollback.
   * Verifies that the file on disk matches the transaction's last written state before restoring or deleting.
   * Preserves any external or user modifications made while the transaction was in flight.
   */
  private async _rollback(
    snapshots: Map<string, FileSnapshot>
  ): Promise<{ conflicts: string[] }> {
    const conflicts: string[] = [];

    for (const [normPath, snap] of snapshots.entries()) {
      try {
        let currentOnDisk: Uint8Array | undefined;
        let currentHash: string | undefined;

        try {
          currentOnDisk = await vscode.workspace.fs.readFile(snap.validatedUri);
          currentHash = this._hash(currentOnDisk);
        } catch {
          // File does not currently exist on disk
          currentOnDisk = undefined;
          currentHash = undefined;
        }

        // Case 1: File was created by this transaction (initialExists === false)
        if (!snap.initialExists) {
          if (currentOnDisk === undefined) {
            // Already gone, nothing to clean up
            continue;
          }
          if (snap.lastWrittenHash && currentHash === snap.lastWrittenHash) {
            // File matches what transaction wrote; safe to delete
            await vscode.workspace.fs.delete(snap.validatedUri, { useTrash: false });
          } else {
            // File was modified externally after transaction wrote it! Do not delete!
            conflicts.push(
              `Conflict on rollback: "${path.basename(normPath)}" was modified externally after creation. Preserved external file.`
            );
          }
        }
        // Case 2: File existed initially and was modified by this transaction
        else if (snap.initialExists && snap.initialContent) {
          if (currentOnDisk === undefined) {
            // File was deleted externally during transaction!
            conflicts.push(
              `Conflict on rollback: "${path.basename(normPath)}" was deleted externally. Original snapshot not restored to avoid unexpected recreation.`
            );
          } else if (snap.lastWrittenHash && currentHash !== snap.lastWrittenHash && currentHash !== snap.initialHash) {
            // File was edited externally during transaction! Do not overwrite user changes!
            conflicts.push(
              `Conflict on rollback: "${path.basename(normPath)}" was modified externally during transaction. Preserved user edits without overwriting.`
            );
          } else {
            // File still matches transaction's write or was untouched; safely restore initial snapshot
            await vscode.workspace.fs.writeFile(snap.validatedUri, snap.initialContent);
          }
        }
        // Case 3: File was deleted by this transaction
        else if (snap.initialExists && !snap.initialContent) {
          if (currentOnDisk !== undefined) {
            conflicts.push(
              `Conflict on rollback: "${path.basename(normPath)}" was recreated externally. Left external recreation intact.`
            );
          }
        }
      } catch (e: any) {
        console.error(`[CodeGenerationEngine] Rollback failed for ${normPath}:`, e);
        conflicts.push(`Error rolling back "${path.basename(normPath)}": ${e?.message || String(e)}`);
      }
    }

    return { conflicts };
  }
}
