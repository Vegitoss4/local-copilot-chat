import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  SessionPersistenceService,
  SessionDataV2
} from '../../src/services/sessionPersistenceService';
import { AtomicFileWriter } from '../../src/services/atomicFileWriter';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 11.2: Persistent Sessions & Multi-Window Safety Suite', () => {
  let service: SessionPersistenceService;
  const tempDir = 'C:\\Projects\\test-workspace';
  const rootUri = MockUri.file(tempDir);

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'persistence-workspace', uri: rootUri, index: 0 }
    ]);
    service = SessionPersistenceService.getInstance();
  });

  describe('Session Storage (Schema v2) & Index Tracking', () => {
    it('should save and load a session in Schema v2 format', async () => {
      const session: SessionDataV2 = {
        schemaVersion: '2.0.0',
        sessionId: 'test_session_101',
        title: 'Refactor Auth Service',
        mode: 'chat',
        model: 'qwen2.5-coder:7b',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'user', content: 'How do I refactor the auth service?' },
          { role: 'assistant', content: 'Here is the step by step plan...' }
        ]
      };

      await service.saveSession(session, rootUri);

      const loaded = await service.loadSession('test_session_101', rootUri);
      assert.ok(loaded);
      assert.strictEqual(loaded.schemaVersion, '2.0.0');
      assert.strictEqual(loaded.sessionId, 'test_session_101');
      assert.strictEqual(loaded.title, 'Refactor Auth Service');
      assert.strictEqual(loaded.messages.length, 2);
    });

    it('should automatically maintain sessions_index.json across saves and deletes', async () => {
      const sessionA: SessionDataV2 = {
        schemaVersion: '2.0.0',
        sessionId: 'sess_A',
        title: 'Session Alpha',
        mode: 'agent',
        model: 'qwen2.5-coder:7b',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'user', content: 'Build tool' }]
      };

      const sessionB: SessionDataV2 = {
        schemaVersion: '2.0.0',
        sessionId: 'sess_B',
        title: 'Session Beta',
        mode: 'plan',
        model: 'deepseek-r1:8b',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'user', content: 'Design schema' }]
      };

      await service.saveSession(sessionA, rootUri);
      await service.saveSession(sessionB, rootUri);

      let sessions = await service.listSessions(rootUri);
      assert.strictEqual(sessions.length, 2);
      assert.ok(sessions.some(s => s.sessionId === 'sess_A'));
      assert.ok(sessions.some(s => s.sessionId === 'sess_B'));

      // Delete session A
      await service.deleteSession('sess_A', rootUri);

      sessions = await service.listSessions(rootUri);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].sessionId, 'sess_B');

      // Verify session A file no longer exists
      const deletedSession = await service.loadSession('sess_A', rootUri);
      assert.strictEqual(deletedSession, null);
    });
  });

  describe('Multi-Window Cooperative File Locking', () => {
    it('should acquire lock for exclusive access and prevent duplicate acquisitions', async () => {
      const lockAcquired = await service.acquireSessionLock('session_lock_test');
      assert.strictEqual(lockAcquired, true);

      // Second attempt to acquire same lock should fail
      const duplicateLock = await service.acquireSessionLock('session_lock_test');
      assert.strictEqual(duplicateLock, false);

      // Release lock and re-acquire
      service.releaseSessionLock('session_lock_test');
      const reacquired = await service.acquireSessionLock('session_lock_test');
      assert.strictEqual(reacquired, true);

      service.releaseSessionLock('session_lock_test');
    });
  });

  describe('Lossless Legacy History Migration', () => {
    it('should migrate legacy chat_history.json to Schema v2 and archive old file', async () => {
      const legacyFileUri = vscode.Uri.joinPath(rootUri, '.vscode', 'local-copilot', 'chat_history.json');
      const legacyHistory = [
        { role: 'user', content: 'Fix the login handler bug' },
        { role: 'assistant', content: '<think>reasoning</think>Fixed the null check in handler.' }
      ];

      await AtomicFileWriter.writeJson(legacyFileUri, legacyHistory);

      const migrated = await service.migrateLegacyHistory(rootUri);
      assert.ok(migrated);
      assert.strictEqual(migrated.schemaVersion, '2.0.0');
      assert.ok(migrated.sessionId.startsWith('migrated_'));
      assert.strictEqual(migrated.title, 'Fix the login handler bug');
      assert.strictEqual(migrated.messages.length, 2);
      assert.strictEqual(migrated.messages[1].content, 'Fixed the null check in handler.');
      assert.strictEqual(migrated.metadata?.migratedFromLegacy, true);

      // Verify sessions index now includes the migrated session
      const sessions = await service.listSessions(rootUri);
      assert.ok(sessions.some(s => s.sessionId === migrated.sessionId));
    });
  });

  describe('Export Utilities', () => {
    it('should export session to Markdown format', () => {
      const session: SessionDataV2 = {
        schemaVersion: '2.0.0',
        sessionId: 'export_01',
        title: 'Export Demo',
        mode: 'chat',
        model: 'qwen2.5-coder:7b',
        createdAt: '2026-11-07T12:00:00Z',
        updatedAt: '2026-11-07T12:05:00Z',
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' }
        ]
      };

      const md = SessionPersistenceService.exportToMarkdown(session);
      assert.ok(md.includes('# Session: Export Demo'));
      assert.ok(md.includes('👤 **User**'));
      assert.ok(md.includes('🤖 **Assistant**'));
      assert.ok(md.includes('What is 2+2?'));
    });

    it('should export session to structured JSON format', () => {
      const session: SessionDataV2 = {
        schemaVersion: '2.0.0',
        sessionId: 'export_02',
        title: 'JSON Export Demo',
        mode: 'agent',
        model: 'qwen2.5-coder:7b',
        createdAt: '2026-11-07T12:00:00Z',
        updatedAt: '2026-11-07T12:05:00Z',
        messages: []
      };

      const jsonStr = SessionPersistenceService.exportToJson(session);
      const parsed = JSON.parse(jsonStr);
      assert.strictEqual(parsed.schemaVersion, '2.0.0');
      assert.strictEqual(parsed.sessionId, 'export_02');
    });
  });
});
