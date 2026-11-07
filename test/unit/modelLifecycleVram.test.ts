import * as assert from 'assert';
import { OllamaService } from '../../src/services/ollamaService';
import { ConfigurationService } from '../../src/services/configurationService';
import { ModelLifecycleManager } from '../../src/services/modelLifecycleManager';
import { resetMockState, MockUri, updateMockConfiguration } from '../mocks/vscodeMock';
import * as vscode from 'vscode';

describe('Phase 5.5 H4.2: Ollama Model Lifecycle & VRAM Management Suite', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
    ConfigurationService.resetInstance();
    ModelLifecycleManager.resetInstance();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    ConfigurationService.resetInstance();
    ModelLifecycleManager.resetInstance();
  });

  describe('1. Ground-Truth Observability via /api/ps', () => {
    it('should parse loaded models correctly from Ollama /api/ps including VRAM size', async () => {
      const mockPs = {
        models: [
          {
            name: 'qwen2.5-coder:7b',
            model: 'qwen2.5-coder:7b',
            size: 4683073984,
            size_vram: 4683073984,
            expires_at: '2026-11-07T02:00:00Z',
          },
          {
            name: 'deepseek-r1:8b',
            model: 'deepseek-r1:8b',
            size: 4920000000,
            size_vram: 4920000000,
            expires_at: '2026-11-07T02:05:00Z',
          },
        ],
      };

      global.fetch = async (url: any) => {
        if (String(url).endsWith('/api/ps')) {
          return {
            ok: true,
            status: 200,
            json: async () => mockPs,
          } as any;
        }
        return { ok: false, status: 404 } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      const loaded = await ollama.getLoadedModels();

      assert.strictEqual(loaded.length, 2);
      assert.strictEqual(loaded[0].name, 'qwen2.5-coder:7b');
      assert.strictEqual(loaded[0].sizeVram, 4683073984);
      assert.strictEqual(loaded[1].name, 'deepseek-r1:8b');
      assert.strictEqual(loaded[1].expiresAt, '2026-11-07T02:05:00Z');
    });

    it('should return empty array gracefully when /api/ps returns non-200 or throws', async () => {
      global.fetch = async () => {
        throw new Error('Endpoint not implemented');
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      const loaded = await ollama.getLoadedModels();
      assert.deepStrictEqual(loaded, []);
    });
  });

  describe('2. ModelLifecycleManager Switching & VRAM Guard', () => {
    it('should allow model switching when generation is inactive and unload previous resident model', async () => {
      const unloadedModels: string[] = [];

      global.fetch = async (url: any, opts: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/ps')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              models: [{ name: 'deepseek-r1:8b', size: 4900000000 }],
            }),
          } as any;
        }
        if (urlStr.endsWith('/api/generate')) {
          const body = JSON.parse(opts?.body || '{}');
          if (body.keep_alive === 0) {
            unloadedModels.push(body.model);
            return { ok: true, status: 200 } as any;
          }
        }
        return { ok: false, status: 404 } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      const config = ConfigurationService.getInstance();
      const manager = ModelLifecycleManager.getInstance(ollama, config);

      const switched = await manager.switchModel('qwen2.5-coder:7b', { aggressiveUnload: true });
      assert.strictEqual(switched, true);
      assert.deepStrictEqual(unloadedModels, ['deepseek-r1:8b'], 'Previous model should be evicted to free VRAM');
      assert.strictEqual(manager.lastActiveModel, 'qwen2.5-coder:7b');
    });

    it('should preserve externally loaded models and not unload them without explicit authorization', async () => {
      const unloadedModels: string[] = [];

      global.fetch = async (url: any, opts: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/ps')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              models: [{ name: 'external-model:14b', size: 8000000000 }],
            }),
          } as any;
        }
        if (urlStr.endsWith('/api/generate')) {
          const body = JSON.parse(opts?.body || '{}');
          if (body.keep_alive === 0) {
            unloadedModels.push(body.model);
            return { ok: true, status: 200 } as any;
          }
        }
        return { ok: false, status: 404 } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      const config = ConfigurationService.getInstance();
      const manager = ModelLifecycleManager.getInstance(ollama, config);

      // Model switch without aggressiveUnload: external model must be preserved
      const switched = await manager.switchModel('qwen2.5-coder:7b');
      assert.strictEqual(switched, true);
      assert.deepStrictEqual(unloadedModels, [], 'External model must NOT be unloaded');
    });

    it('should reject model switching when generation is currently active', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const config = ConfigurationService.getInstance();
      const manager = ModelLifecycleManager.getInstance(ollama, config);

      manager.notifyGenerationStart('qwen2.5-coder:7b');
      assert.strictEqual(manager.isGenerationActive, true);

      await assert.rejects(
        async () => {
          await manager.switchModel('deepseek-r1:8b');
        },
        (err: any) => {
          assert.match(err.message, /generation turn is currently active/);
          return true;
        }
      );

      await manager.notifyGenerationEnd('qwen2.5-coder:7b');
      assert.strictEqual(manager.isGenerationActive, false);
    });

    it('should fail closed when attempting unloadCurrentModel during active generation', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const config = ConfigurationService.getInstance();
      const manager = ModelLifecycleManager.getInstance(ollama, config);

      manager.notifyGenerationStart('qwen2.5-coder:7b');

      const success = await manager.unloadCurrentModel();
      assert.strictEqual(success, false, 'Unload must fail closed during active generation');

      await manager.notifyGenerationEnd('qwen2.5-coder:7b');
    });
  });

  describe('3. Unload Policies (unloadImmediately & unloadOnIdle)', () => {
    it('should immediately unload model after generation turn when policy is unloadImmediately', async () => {
      const unloadedModels: string[] = [];

      global.fetch = async (url: any, opts: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/generate')) {
          const body = JSON.parse(opts?.body || '{}');
          if (body.keep_alive === 0) {
            unloadedModels.push(body.model);
            return { ok: true, status: 200 } as any;
          }
        }
        return { ok: false, status: 404 } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      updateMockConfiguration('localCopilot.modelUnloadPolicy', 'unloadImmediately');
      const config = ConfigurationService.getInstance();

      const manager = ModelLifecycleManager.getInstance(ollama, config);

      manager.notifyGenerationStart('qwen2.5-coder:7b');
      assert.strictEqual(manager.isGenerationActive, true);

      await manager.notifyGenerationEnd('qwen2.5-coder:7b');
      assert.strictEqual(manager.isGenerationActive, false);
      assert.deepStrictEqual(unloadedModels, ['qwen2.5-coder:7b'], 'Model must be unloaded immediately after turn');
    });

    it('should arm idle timer and unload model after idle period when policy is unloadOnIdle', async () => {
      const unloadedModels: string[] = [];

      global.fetch = async (url: any, opts: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/generate')) {
          const body = JSON.parse(opts?.body || '{}');
          if (body.keep_alive === 0) {
            unloadedModels.push(body.model);
            return { ok: true, status: 200 } as any;
          }
        }
        return { ok: false, status: 404 } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      updateMockConfiguration('localCopilot.modelUnloadPolicy', 'unloadOnIdle');
      const config = ConfigurationService.getInstance();

      const manager = ModelLifecycleManager.getInstance(ollama, config);
      manager.idleUnloadTimeoutMs = 50;

      manager.notifyGenerationStart('qwen2.5-coder:7b');
      await manager.notifyGenerationEnd('qwen2.5-coder:7b');

      assert.strictEqual(unloadedModels.length, 0, 'Should not unload immediately under unloadOnIdle');

      // Await idle timer expiration
      await new Promise((r) => setTimeout(r, 70));
      assert.deepStrictEqual(unloadedModels, ['qwen2.5-coder:7b'], 'Model should be unloaded after idle timeout');
    });

    it('should disarm idle timer if a new generation begins before timeout expires', async () => {
      const unloadedModels: string[] = [];

      global.fetch = async (url: any, opts: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/generate')) {
          const body = JSON.parse(opts?.body || '{}');
          if (body.keep_alive === 0) {
            unloadedModels.push(body.model);
            return { ok: true, status: 200 } as any;
          }
        }
        return { ok: false, status: 404 } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      updateMockConfiguration('localCopilot.modelUnloadPolicy', 'unloadOnIdle');
      const config = ConfigurationService.getInstance();

      const manager = ModelLifecycleManager.getInstance(ollama, config);
      manager.idleUnloadTimeoutMs = 80;

      manager.notifyGenerationStart('qwen2.5-coder:7b');
      await manager.notifyGenerationEnd('qwen2.5-coder:7b');

      // User starts another turn at 30ms before the 80ms timer expires
      await new Promise((r) => setTimeout(r, 30));
      manager.notifyGenerationStart('qwen2.5-coder:7b');

      // Wait past the original 80ms deadline
      await new Promise((r) => setTimeout(r, 70));
      assert.strictEqual(unloadedModels.length, 0, 'Idle unload must be cancelled by new active turn');

      await manager.notifyGenerationEnd('qwen2.5-coder:7b');
    });

    it('should send keep_alive parameter in streamChat when configured', async () => {
      let sentKeepAlive: any = undefined;

      global.fetch = async (_url: any, opts: any) => {
        const body = JSON.parse(opts?.body || '{}');
        sentKeepAlive = body.keep_alive;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => ({ done: true, value: undefined }),
            }),
          },
        } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      await ollama.streamChat(
        'qwen2.5-coder:7b',
        [{ role: 'user', content: 'hello' }],
        () => {},
        undefined,
        { num_ctx: 4096, temperature: 0.1, keep_alive: 0 }
      );

      assert.strictEqual(sentKeepAlive, 0, 'keep_alive: 0 must be forwarded in chat payload');
    });
  });
});
