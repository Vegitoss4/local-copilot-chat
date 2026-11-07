import * as assert from 'assert';
import * as http from 'http';
import { OllamaService, OllamaVramError } from '../../src/services/ollamaService';
import { ModelLifecycleManager, MementoLike } from '../../src/services/modelLifecycleManager';
import { ConfigurationService } from '../../src/services/configurationService';
import { nativeFetch } from '../setup';
import { updateMockConfiguration } from '../mocks/vscodeMock';

describe('Phase 8.1e: Real Fake-Ollama Server & Multi-Client VRAM Durability Tier', function () {
  this.timeout(10000);

  let originalFetch: any;
  let server: http.Server | undefined;
  let serverPort: number;
  let serverUrl: string;
  let unloadedModels: Array<{ model: string; keep_alive: number }>;

  beforeEach(() => {
    originalFetch = global.fetch;
    if (nativeFetch) {
      global.fetch = nativeFetch;
    }
    unloadedModels = [];
    ModelLifecycleManager.resetInstance();
  });

  afterEach((done) => {
    global.fetch = originalFetch;
    ModelLifecycleManager.resetInstance();
    if (server) {
      server.close(() => {
        server = undefined;
        done();
      });
    } else {
      done();
    }
  });

  function startFakeOllamaServer(): Promise<void> {
    server = http.createServer((req, res) => {
      const url = req.url || '';

      if (req.method === 'GET' && url.startsWith('/api/tags')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              { name: 'external-user-model:latest' },
              { name: 'extension-owned:7b' },
              { name: 'new-target:7b' },
              { name: 'oom-model:14b' }
            ]
          })
        );
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/ps')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'external-user-model:latest',
                model: 'external-user-model:latest',
                size_vram: 4000000000
              },
              {
                name: 'extension-owned:7b',
                model: 'extension-owned:7b',
                size_vram: 3500000000
              }
            ]
          })
        );
        return;
      }

      if (req.method === 'POST' && url.startsWith('/api/generate')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.keep_alive !== undefined) {
              unloadedModels.push({ model: parsed.model, keep_alive: parsed.keep_alive });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ done: true }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }

      if (req.method === 'POST' && url.startsWith('/api/chat')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.model === 'oom-model:14b') {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('model requires more system memory (12.4 GiB) than available (7.8 GiB)');
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: 'OK' } }) + '\n');
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as any;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  }

  it('should preserve external models and only unload extension-owned models during switchModel', async () => {
    await startFakeOllamaServer();
    updateMockConfiguration('localCopilot.modelUnloadPolicy', 'unloadImmediately');

    const ollama = new OllamaService(serverUrl);
    const config = ConfigurationService.getInstance();

    const manager = new ModelLifecycleManager(ollama, config);
    // Register ownership only for extension-owned:7b
    manager.registerModelOwnership('extension-owned:7b');

    // Switch to new-target:7b (without aggressiveUnload: rely on ownership policy)
    const switched = await manager.switchModel('new-target:7b');
    assert.strictEqual(switched, true);

    // Verify unloadedModels contains ONLY extension-owned:7b with keep_alive: 0
    const unloadedNames = unloadedModels.map((u) => u.model);
    assert.ok(
      unloadedNames.includes('extension-owned:7b'),
      'extension-owned:7b was not unloaded'
    );
    assert.strictEqual(
      unloadedNames.includes('external-user-model:latest'),
      false,
      'CRITICAL: External model was improperly unloaded, disrupting other processes!'
    );
  });

  it('should transform out-of-memory HTTP 500 into actionable OllamaVramError', async () => {
    await startFakeOllamaServer();

    const ollama = new OllamaService(serverUrl);

    let thrown: any = null;
    try {
      await ollama.streamChat('oom-model:14b', [{ role: 'user', content: 'hello' }], () => {});
    } catch (err: any) {
      thrown = err;
    }

    assert.ok(thrown, 'Expected VRAM error not thrown');
    assert.ok(
      thrown instanceof OllamaVramError,
      `Expected OllamaVramError, got ${thrown?.name}: ${thrown?.message}`
    );
    assert.ok(
      thrown.message.includes('8 GB VRAM budget constraint'),
      'Error does not mention 8 GB VRAM budget constraint'
    );
    assert.ok(
      thrown.message.includes('num_ctx'),
      'Error does not provide actionable advice on num_ctx'
    );
  });

  it('should restore extension-owned model tracking across reloads via MementoLike', async () => {
    const store: Record<string, any> = {};
    const mockMemento: MementoLike = {
      get: <T>(key: string, defaultValue?: T): T => {
        return store[key] !== undefined ? store[key] : (defaultValue as T);
      },
      update: (key: string, value: any) => {
        store[key] = value;
        return Promise.resolve();
      }
    };

    const ollama = new OllamaService('http://127.0.0.1:11434');
    const config = ConfigurationService.getInstance();

    // Session 1: load manager, record model ownership
    const manager1 = new ModelLifecycleManager(ollama, config, mockMemento);
    manager1.registerModelOwnership('coder-persona:7b');
    manager1.registerModelOwnership('tester-persona:7b');

    // Verify memento updated
    const saved = store['localCopilot.ownedModels'];
    assert.ok(Array.isArray(saved));
    assert.ok(saved.includes('coder-persona:7b'));
    assert.ok(saved.includes('tester-persona:7b'));

    // Session 2: simulate reload (new instance with same memento)
    const manager2 = new ModelLifecycleManager(ollama, config, mockMemento);
    assert.strictEqual(manager2.isModelOwned('coder-persona:7b'), true);
    assert.strictEqual(manager2.isModelOwned('tester-persona:7b'), true);
    assert.strictEqual(manager2.isModelOwned('random-other:latest'), false);
  });
});
