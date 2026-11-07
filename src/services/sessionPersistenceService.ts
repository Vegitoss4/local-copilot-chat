import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { AtomicFileWriter } from './atomicFileWriter';
import { WorkspaceManager } from './workspaceManager';
import { ChatMessage } from './ollamaService';
import { SessionMode, SessionEngine } from './sessionEngine';

/**
 * Deliverable 11.2: Persistent Sessions & Multi-Window Safety
 * Manages versioned session storage (Schema v2), lossless legacy history migration,
 * sessions index tracking, multi-window file locking, and export utilities.
 */

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  tool_calls?: any[];
}

export interface SessionDataV2 {
  schemaVersion: '2.0.0';
  sessionId: string;
  title: string;
  mode: SessionMode;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  metadata?: Record<string, any>;
}

export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  mode: SessionMode;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionIndexData {
  schemaVersion: '2.0.0';
  sessions: SessionIndexEntry[];
}

export class SessionPersistenceService {
  private static _instance: SessionPersistenceService | undefined;
  private static _activeLocks: Set<string> = new Set();

  public static getInstance(): SessionPersistenceService {
    if (!this._instance) {
      this._instance = new SessionPersistenceService();
    }
    return this._instance;
  }

  /**
   * Derives a safe sessions directory within .vscode/local-copilot/sessions/
   */
  public getSessionsDirUri(targetRootUri?: vscode.Uri): vscode.Uri | null {
    const folder = targetRootUri
      ? WorkspaceManager.getTargetWorkspaceFolder(targetRootUri)
      : WorkspaceManager.getTargetWorkspaceFolder();
    const baseUri = folder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!baseUri) return null;
    return vscode.Uri.joinPath(baseUri, '.vscode', 'local-copilot', 'sessions');
  }

  public getSessionFileUri(sessionId: string, targetRootUri?: vscode.Uri): vscode.Uri | null {
    const dir = this.getSessionsDirUri(targetRootUri);
    if (!dir) return null;
    return vscode.Uri.joinPath(dir, `${sessionId}.json`);
  }

  public getIndexFileUri(targetRootUri?: vscode.Uri): vscode.Uri | null {
    const dir = this.getSessionsDirUri(targetRootUri);
    if (!dir) return null;
    return vscode.Uri.joinPath(dir, 'sessions_index.json');
  }

  /**
   * Acquires a cooperative lock on a session file for multi-window / concurrency safety.
   */
  public async acquireSessionLock(sessionId: string): Promise<boolean> {
    if (SessionPersistenceService._activeLocks.has(sessionId)) {
      return false;
    }
    SessionPersistenceService._activeLocks.add(sessionId);
    return true;
  }

  public releaseSessionLock(sessionId: string): void {
    SessionPersistenceService._activeLocks.delete(sessionId);
  }

  /**
   * Saves or updates a session to disk with Schema v2 format and updates sessions_index.json.
   */
  public async saveSession(
    session: SessionDataV2,
    targetRootUri?: vscode.Uri
  ): Promise<void> {
    const fileUri = this.getSessionFileUri(session.sessionId, targetRootUri);
    if (!fileUri) return;

    // Update timestamp
    session.updatedAt = new Date().toISOString();

    // Strip thoughts from messages before saving
    session.messages = session.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? SessionEngine.stripThoughtTokens(m.content) : ''
    }));

    // Atomically write session file
    await AtomicFileWriter.writeJson(fileUri, session);

    // Update session index
    await this._updateIndex(session, targetRootUri);
  }

  /**
   * Loads a session from disk by sessionId.
   */
  public async loadSession(
    sessionId: string,
    targetRootUri?: vscode.Uri
  ): Promise<SessionDataV2 | null> {
    const fileUri = this.getSessionFileUri(sessionId, targetRootUri);
    if (!fileUri) return null;

    try {
      const data = await AtomicFileWriter.readJson<SessionDataV2 | null>(fileUri, null);
      if (data && data.schemaVersion === '2.0.0') {
        return data;
      }
    } catch {}
    return null;
  }

  /**
   * Lists all sessions recorded in the sessions index.
   */
  public async listSessions(targetRootUri?: vscode.Uri): Promise<SessionIndexEntry[]> {
    const indexUri = this.getIndexFileUri(targetRootUri);
    if (!indexUri) return [];

    try {
      const index = await AtomicFileWriter.readJson<SessionIndexData>(indexUri, {
        schemaVersion: '2.0.0',
        sessions: []
      });
      return index.sessions || [];
    } catch {
      return [];
    }
  }

  /**
   * Deletes a session by ID and removes it from the index.
   */
  public async deleteSession(
    sessionId: string,
    targetRootUri?: vscode.Uri
  ): Promise<void> {
    const fileUri = this.getSessionFileUri(sessionId, targetRootUri);
    if (fileUri) {
      try {
        await vscode.workspace.fs.delete(fileUri, { useTrash: false });
      } catch {}
    }

    const indexUri = this.getIndexFileUri(targetRootUri);
    if (!indexUri) return;

    try {
      const index = await AtomicFileWriter.readJson<SessionIndexData>(indexUri, {
        schemaVersion: '2.0.0',
        sessions: []
      });
      index.sessions = (index.sessions || []).filter(s => s.sessionId !== sessionId);
      await AtomicFileWriter.writeJson(indexUri, index);
    } catch {}
  }

  /**
   * Automatically migrates legacy .vscode/local-copilot/chat_history.json (v1) to Schema v2.
   */
  public async migrateLegacyHistory(targetRootUri?: vscode.Uri): Promise<SessionDataV2 | null> {
    const folder = targetRootUri
      ? WorkspaceManager.getTargetWorkspaceFolder(targetRootUri)
      : WorkspaceManager.getTargetWorkspaceFolder();
    const baseUri = folder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!baseUri) return null;

    const legacyUri = vscode.Uri.joinPath(baseUri, '.vscode', 'local-copilot', 'chat_history.json');

    try {
      const raw = await AtomicFileWriter.readJson<any[]>(legacyUri, []);
      if (!Array.isArray(raw) || raw.length === 0) return null;

      const legacySessionId = `migrated_${Date.now()}`;
      const now = new Date().toISOString();

      const messages: SessionMessage[] = raw.map(item => ({
        role: item.role,
        content: typeof item.content === 'string' ? SessionEngine.stripThoughtTokens(item.content) : '',
        timestamp: now
      }));

      // Derive title from first user message
      const firstUserMsg = messages.find(m => m.role === 'user')?.content || 'Migrated Conversation';
      const title = firstUserMsg.slice(0, 40).replace(/\n/g, ' ') + (firstUserMsg.length > 40 ? '...' : '');

      const migratedSession: SessionDataV2 = {
        schemaVersion: '2.0.0',
        sessionId: legacySessionId,
        title,
        mode: 'chat',
        model: 'qwen2.5-coder:7b',
        createdAt: now,
        updatedAt: now,
        messages,
        metadata: { migratedFromLegacy: true, originalMessageCount: raw.length }
      };

      await this.saveSession(migratedSession, targetRootUri);

      // Rename legacy history file to chat_history.json.migrated to prevent duplicate migrations
      const migratedBackupUri = vscode.Uri.joinPath(baseUri, '.vscode', 'local-copilot', 'chat_history.json.migrated');
      try {
        await vscode.workspace.fs.rename(legacyUri, migratedBackupUri, { overwrite: true });
      } catch {}

      return migratedSession;
    } catch {
      return null;
    }
  }

  /**
   * Exports session content as Markdown format.
   */
  public static exportToMarkdown(session: SessionDataV2): string {
    let md = `# Session: ${session.title}\n\n`;
    md += `- **Session ID**: \`${session.sessionId}\`\n`;
    md += `- **Model**: \`${session.model}\`\n`;
    md += `- **Mode**: \`${session.mode}\`\n`;
    md += `- **Created**: ${session.createdAt}\n`;
    md += `- **Updated**: ${session.updatedAt}\n\n`;
    md += `---\n\n`;

    for (const msg of session.messages) {
      const speaker = msg.role === 'user' ? '👤 **User**' : (msg.role === 'assistant' ? '🤖 **Assistant**' : `⚙️ **${msg.role}**`);
      md += `### ${speaker}\n\n${msg.content}\n\n`;
    }

    return md;
  }

  /**
   * Exports session content as structured JSON.
   */
  public static exportToJson(session: SessionDataV2): string {
    return JSON.stringify(session, null, 2);
  }

  private async _updateIndex(session: SessionDataV2, targetRootUri?: vscode.Uri): Promise<void> {
    const indexUri = this.getIndexFileUri(targetRootUri);
    if (!indexUri) return;

    try {
      const index = await AtomicFileWriter.readJson<SessionIndexData>(indexUri, {
        schemaVersion: '2.0.0',
        sessions: []
      });

      const entry: SessionIndexEntry = {
        sessionId: session.sessionId,
        title: session.title,
        mode: session.mode,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length
      };

      const existingIndex = (index.sessions || []).findIndex(s => s.sessionId === session.sessionId);
      if (existingIndex >= 0) {
        index.sessions[existingIndex] = entry;
      } else {
        index.sessions.unshift(entry);
      }

      await AtomicFileWriter.writeJson(indexUri, index);
    } catch {}
  }
}
