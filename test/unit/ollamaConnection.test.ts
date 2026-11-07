import * as assert from 'assert';
import { OllamaService } from '../../src/services/ollamaService';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { resetMockState, MockUri } from '../mocks/vscodeMock';

describe('Ollama Connection Reliability Suite', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('1. OllamaService.getAvailableModels() Endpoint Reliability', () => {
    it('should return model array when Ollama is running and returns 200 OK', async () => {
      const mockModels = [{ name: 'qwen2.5-coder:7b' }, { name: 'deepseek-r1:8b' }];
      global.fetch = async (url: any) => {
        assert.ok(String(url).endsWith('/api/tags'));
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: mockModels }),
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const models = await service.getAvailableModels();
      assert.deepStrictEqual(models, ['qwen2.5-coder:7b', 'deepseek-r1:8b']);
    });

    it('should cleanly handle empty model list when Ollama is running but no models are pulled', async () => {
      global.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [] }),
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const models = await service.getAvailableModels();
      assert.deepStrictEqual(models, []);
    });

    it('should throw an endpoint-specific error when Ollama is offline or connection fails', async () => {
      global.fetch = async () => {
        throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      await assert.rejects(
        async () => {
          await service.getAvailableModels();
        },
        (err: Error) => {
          assert.match(err.message, /Unable to connect to Ollama at http:\/\/127\.0\.0\.1:11434/);
          assert.match(err.message, /Please make sure Ollama is running/);
          return true;
        }
      );
    });

    it('should throw HTTP status-specific error when endpoint returns 500 or 404', async () => {
      global.fetch = async () => {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      await assert.rejects(
        async () => {
          await service.getAvailableModels();
        },
        (err: Error) => {
          assert.match(err.message, /Ollama returned HTTP 404/);
          return true;
        }
      );
    });

    it('should include custom endpoint URL in error messages for invalid or remote endpoints', async () => {
      global.fetch = async () => {
        throw new Error('getaddrinfo ENOTFOUND invalid-ollama-host');
      };

      const service = new OllamaService('http://invalid-ollama-host:11434');
      await assert.rejects(
        async () => {
          await service.getAvailableModels();
        },
        (err: Error) => {
          assert.match(err.message, /invalid-ollama-host:11434/);
          return true;
        }
      );
    });
  });

  describe('2. ChatViewProvider Connection State Machine & Concurrency Control', () => {
    let mockWebviewMessages: any[] = [];
    let mockWebview: any;

    beforeEach(() => {
      resetMockState('C:/Projects/test-workspace');
      mockWebviewMessages = [];
      mockWebview = {
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: async (msg: any) => {
          mockWebviewMessages.push(msg);
        },
      };
    });

    it('should post modelsLoading and modelsList when Ollama is available', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }),
      } as any);

      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      (provider as any)._view = { webview: mockWebview };

      await (provider as any)._handleFetchModels();

      const loadingMsg = mockWebviewMessages.find((m) => m.type === 'modelsLoading');
      const listMsg = mockWebviewMessages.find((m) => m.type === 'modelsList');

      assert.ok(loadingMsg, 'Expected modelsLoading message to be posted');
      assert.ok(listMsg, 'Expected modelsList message to be posted');
      assert.deepStrictEqual(listMsg.models, ['qwen2.5-coder:7b']);
      assert.strictEqual(listMsg.endpoint, 'http://127.0.0.1:11434');
    });

    it('should post modelsError with actionable diagnostic when connection fails', async () => {
      global.fetch = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      (provider as any)._view = { webview: mockWebview };

      await (provider as any)._handleFetchModels();

      const errorMsg = mockWebviewMessages.find((m) => m.type === 'modelsError');
      assert.ok(errorMsg, 'Expected modelsError message to be posted');
      assert.match(errorMsg.error, /Unable to connect to Ollama at http:\/\/127\.0\.0\.1:11434/);
      assert.strictEqual(errorMsg.endpoint, 'http://127.0.0.1:11434');
    });

    it('should prevent concurrent duplicate fetch requests', async () => {
      let fetchCount = 0;
      global.fetch = async () => {
        fetchCount++;
        // Simulate network latency
        await new Promise((r) => setTimeout(r, 50));
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }),
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      (provider as any)._view = { webview: mockWebview };

      // Trigger two fetch operations concurrently
      const promise1 = (provider as any)._handleFetchModels();
      const promise2 = (provider as any)._handleFetchModels();

      await Promise.all([promise1, promise2]);

      // Only one network call should have occurred due to _isFetchingModels guard
      assert.strictEqual(fetchCount, 1, 'Concurrent fetch should have been blocked');
    });

    it('should discard stale asynchronous responses when request ID is superseded', async () => {
      const responses = [
        // Request 1: slow response with old model
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({ models: [{ name: 'old-model' }] }),
              } as any),
            80
          )
        ),
        // Request 2: fast response with new model
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'new-model' }] }),
        } as any),
      ];

      let callIdx = 0;
      global.fetch = async () => responses[callIdx++];

      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      (provider as any)._view = { webview: mockWebview };

      // Dispatch request 1
      const p1 = (provider as any)._handleFetchModels();
      // Manually reset fetching guard to simulate second user retry triggering request 2
      (provider as any)._isFetchingModels = false;
      const p2 = (provider as any)._handleFetchModels();

      await Promise.all([p1, p2]);

      const listMessages = mockWebviewMessages.filter((m) => m.type === 'modelsList');
      // The final posted modelsList should be for the latest request (new-model), not old-model
      const lastList = listMessages[listMessages.length - 1];
      assert.deepStrictEqual(lastList.models, ['new-model']);
    });

    it('should preserve model auto-routing heuristics after model updates', () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);

      (provider as any)._cachedModels = ['qwen2.5-coder:7b', 'deepseek-r1:8b'];

      // Reasoning keywords should route to DeepSeek
      const reasonModel = provider.resolveAutoModel('Can you explain why this code is failing?', 'chat');
      assert.strictEqual(reasonModel, 'deepseek-r1:8b');

      // Coding keywords should route to Qwen
      const codeModel = provider.resolveAutoModel('Write a function to format currency', 'chat');
      assert.strictEqual(codeModel, 'qwen2.5-coder:7b');

      // Agent mode always defaults to reasoning/orchestrator model
      const agentModel = provider.resolveAutoModel('Task', 'agent');
      assert.strictEqual(agentModel, 'deepseek-r1:8b');
    });
  });
});
