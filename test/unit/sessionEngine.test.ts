import * as assert from 'assert';
import {
  SessionEngine,
  GenerationActiveError,
  SessionMode
} from '../../src/services/sessionEngine';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 11.0: SessionEngine Core & Orchestration Suite', () => {
  let mockOllamaService: any;
  let sessionEngine: SessionEngine;
  const tempDir = 'C:\\Projects\\test-workspace';

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'session-workspace', uri: MockUri.file(tempDir), index: 0 }
    ]);

    SessionEngine.resetInstance();

    mockOllamaService = {
      streamChat: async (
        model: string,
        messages: any[],
        onChunk: (chunk: string) => void,
        signal?: AbortSignal,
        options?: any,
        timeouts?: any
      ): Promise<string> => {
        const lastMsg = messages[messages.length - 1]?.content || '';

        if (lastMsg.includes('slowTurn')) {
          onChunk('Starting slow turn...');
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              return reject(err);
            }
            const timer = setTimeout(resolve, 50);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
          onChunk(' finished slow turn.');
          return 'Starting slow turn... finished slow turn.';
        }

        if (lastMsg.includes('reasoningPrompt')) {
          const raw = '<think>\ninternal reasoning process\n</think>\nFinal answer: 42.';
          onChunk(raw);
          return raw;
        }

        onChunk('Hello from Ollama!');
        return 'Hello from Ollama!';
      }
    };

    sessionEngine = new SessionEngine(mockOllamaService as unknown as OllamaService);
  });

  afterEach(() => {
    sessionEngine.stopGeneration();
    SessionEngine.resetInstance();
  });

  describe('Session Configuration & State', () => {
    it('should initialize with default mode and model', () => {
      assert.strictEqual(sessionEngine.getMode(), 'chat');
      assert.strictEqual(sessionEngine.getModel(), 'qwen2.5-coder:7b');
      assert.strictEqual(sessionEngine.isGenerating(), false);
      assert.ok(sessionEngine.getSessionId().startsWith('session_'));
    });

    it('should update mode and model cleanly', () => {
      sessionEngine.setMode('plan');
      assert.strictEqual(sessionEngine.getMode(), 'plan');

      sessionEngine.setModel('deepseek-r1:8b');
      assert.strictEqual(sessionEngine.getModel(), 'deepseek-r1:8b');
    });

    it('should strip thought tokens without leaking internal reasoning into context', () => {
      const dirty = '<think>\nSecret CoT steps\n</think>\nClean output code';
      const clean = SessionEngine.stripThoughtTokens(dirty);
      assert.strictEqual(clean, 'Clean output code');

      const unclosed = '<think>\nUnclosed reasoning block\nstill reasoning...';
      const cleanUnclosed = SessionEngine.stripThoughtTokens(unclosed);
      assert.strictEqual(cleanUnclosed, '');
    });
  });

  describe('Single-Flight Turn Mutex & Concurrency Guard', () => {
    it('should reject overlapping sendMessage turn with GenerationActiveError', async () => {
      const slowPromise = sessionEngine.sendMessage('slowTurn', { mode: 'chat' });

      // Immediate overlapping request while slowTurn is generating
      await assert.rejects(
        async () => {
          await sessionEngine.sendMessage('secondOverlappingTurn', { mode: 'chat' });
        },
        (err: any) => {
          assert.strictEqual(err.name, 'GenerationActiveError');
          assert.ok(err.message.includes('already in progress'));
          return true;
        }
      );

      await slowPromise;
      assert.strictEqual(sessionEngine.isGenerating(), false);
    });

    it('should unlock generation mutex when stopGeneration is called', async () => {
      const slowPromise = sessionEngine.sendMessage('slowTurn', { mode: 'chat' });
      assert.strictEqual(sessionEngine.isGenerating(), true);

      sessionEngine.stopGeneration();

      const result = await slowPromise;
      assert.strictEqual(result, '');
      assert.strictEqual(sessionEngine.isGenerating(), false);

      // Now a new turn should succeed cleanly
      const nextTurn = await sessionEngine.sendMessage('regularTurn', { mode: 'chat' });
      assert.strictEqual(nextTurn, 'Hello from Ollama!');
    });
  });

  describe('Event Bus & Turn Lifecycle', () => {
    it('should emit tokens, stream lifecycle events, and suppress thought tokens from history', async () => {
      const emittedTokens: string[] = [];
      let turnStarted = false;
      let streamEnded = false;

      sessionEngine.setEvents({
        onStartStream: (p) => {
          turnStarted = true;
          assert.strictEqual(p.userText, 'reasoningPrompt');
        },
        onToken: (tok) => {
          emittedTokens.push(tok);
        },
        onStreamEnd: (p) => {
          streamEnded = true;
          assert.strictEqual(p.cleanResponse, 'Final answer: 42.');
        }
      });

      const response = await sessionEngine.sendMessage('reasoningPrompt', { mode: 'chat' });
      assert.strictEqual(response, 'Final answer: 42.');
      assert.strictEqual(turnStarted, true);
      assert.strictEqual(streamEnded, true);
      assert.ok(emittedTokens.length > 0);

      // Verify that chat history stores only the cleaned response
      const history = sessionEngine.getHistory();
      const assistantMsg = history.find(m => m.role === 'assistant');
      assert.ok(assistantMsg);
      assert.strictEqual(assistantMsg.content, 'Final answer: 42.');
      assert.ok(!assistantMsg.content.includes('<think>'));
    });

    it('should handle Plan Mode strictly as read-only planning', async () => {
      const response = await sessionEngine.sendMessage('Design a caching system', { mode: 'plan' });
      assert.strictEqual(response, 'Hello from Ollama!');

      const history = sessionEngine.getHistory();
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].role, 'user');
      assert.strictEqual(history[1].role, 'assistant');
    });

    it('should route /help and /clear slash commands', async () => {
      const helpRes = await sessionEngine.sendMessage('/help');
      assert.ok(helpRes.includes('Jarvis Commands'));
      assert.ok(helpRes.includes('/plan'));

      sessionEngine.setHistory([{ role: 'user', content: 'prior msg' }]);
      assert.strictEqual(sessionEngine.getHistory().length, 1);

      const clearRes = await sessionEngine.sendMessage('/clear');
      assert.ok(clearRes.includes('history cleared'));
      assert.strictEqual(sessionEngine.getHistory().length, 0);
    });
  });
});
