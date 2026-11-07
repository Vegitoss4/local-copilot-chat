import * as assert from 'assert';
import { OllamaService, OllamaTimeoutError } from '../../src/services/ollamaService';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { resetMockState, MockUri } from '../mocks/vscodeMock';
import * as vscode from 'vscode';

describe('Phase 5.5 H4.1: Ollama Resilience, Lifecycle & Timeout Suite', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('1. Endpoint Health Probe & Connect Timeouts', () => {
    it('should abort getAvailableModels with connect timeout when endpoint does not respond', async () => {
      global.fetch = (_url: any, options: any) => {
        return new Promise((_resolve, reject) => {
          // Listen to signal and reject when aborted
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      await assert.rejects(
        async () => {
          await service.getAvailableModels({ connectTimeoutMs: 50 });
        },
        (err: any) => {
          assert.ok(err instanceof OllamaTimeoutError, `Expected OllamaTimeoutError but got: ${err}`);
          assert.strictEqual(err.phase, 'connect');
          assert.strictEqual(err.timeoutMs, 50);
          return true;
        }
      );
    });

    it('should return true for ping() when endpoint responds quickly and false on timeout', async () => {
      let callCount = 0;
      global.fetch = async (_url: any, options: any) => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }),
          } as any;
        } else {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        }
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const firstPing = await service.ping(200);
      assert.strictEqual(firstPing, true, 'First ping should succeed');

      const secondPing = await service.ping(50);
      assert.strictEqual(secondPing, false, 'Second ping should fail safely on timeout');
    });
  });

  describe('2. Multi-Tier Stream Timeouts (Headers, Idle, Total)', () => {
    it('should abort streamChat with headers timeout when server takes too long to send HTTP 200', async () => {
      global.fetch = (_url: any, options: any) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      await assert.rejects(
        async () => {
          await service.streamChat(
            'qwen2.5-coder:7b',
            [{ role: 'user', content: 'hello' }],
            () => {},
            undefined,
            undefined,
            { headersTimeoutMs: 60, totalTimeoutMs: 5000 }
          );
        },
        (err: any) => {
          assert.ok(err instanceof OllamaTimeoutError, `Expected OllamaTimeoutError, got: ${err}`);
          assert.strictEqual(err.phase, 'headers');
          assert.strictEqual(err.timeoutMs, 60);
          return true;
        }
      );
    });

    it('should reset idle timer on incoming chunks and stream to completion normally', async () => {
      const chunks = ['Hello', ' world', '! How', ' are', ' you?'];
      const textEncoder = new TextEncoder();

      global.fetch = async () => {
        let chunkIndex = 0;
        const stream = new ReadableStream({
          async pull(controller) {
            if (chunkIndex < chunks.length) {
              const text = JSON.stringify({ message: { content: chunks[chunkIndex++] } }) + '\n';
              controller.enqueue(textEncoder.encode(text));
              // Small delay between chunks to verify sliding timer reset
              await new Promise((r) => setTimeout(r, 20));
            } else {
              controller.close();
            }
          },
        });

        return {
          ok: true,
          status: 200,
          body: stream,
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const received: string[] = [];

      const fullResult = await service.streamChat(
        'qwen2.5-coder:7b',
        [{ role: 'user', content: 'test' }],
        (chunk) => received.push(chunk),
        undefined,
        undefined,
        { headersTimeoutMs: 500, idleStreamTimeoutMs: 100, totalTimeoutMs: 2000 }
      );

      assert.strictEqual(fullResult, 'Hello world! How are you?');
      assert.deepStrictEqual(received, chunks);
    });

    it('should abort streamChat with idle_stream timeout when stream halts mid-generation', async () => {
      const textEncoder = new TextEncoder();

      global.fetch = async (_url: any, options: any) => {
        let sentFirstChunk = false;
        const stream = new ReadableStream({
          async pull(controller) {
            if (!sentFirstChunk) {
              sentFirstChunk = true;
              const text = JSON.stringify({ message: { content: 'First partial chunk' } }) + '\n';
              controller.enqueue(textEncoder.encode(text));
            } else {
              // Wait indefinitely until signal aborts to simulate stalled stream
              await new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                  const err = new Error('aborted');
                  err.name = 'AbortError';
                  reject(err);
                });
              });
            }
          },
        });

        return {
          ok: true,
          status: 200,
          body: stream,
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      const received: string[] = [];

      await assert.rejects(
        async () => {
          await service.streamChat(
            'qwen2.5-coder:7b',
            [{ role: 'user', content: 'test' }],
            (chunk) => received.push(chunk),
            undefined,
            undefined,
            { headersTimeoutMs: 500, idleStreamTimeoutMs: 60, totalTimeoutMs: 5000 }
          );
        },
        (err: any) => {
          assert.ok(err instanceof OllamaTimeoutError, `Expected OllamaTimeoutError, got: ${err}`);
          assert.strictEqual(err.phase, 'idle_stream');
          assert.strictEqual(err.timeoutMs, 60);
          return true;
        }
      );

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], 'First partial chunk');
    });

    it('should abort streamChat with total timeout when generation turn exceeds ceiling', async () => {
      const textEncoder = new TextEncoder();

      global.fetch = async (_url: any, options: any) => {
        const stream = new ReadableStream({
          async pull(controller) {
            if (options?.signal?.aborted) {
              controller.close();
              return;
            }
            // Emits chunks every 25ms indefinitely
            const text = JSON.stringify({ message: { content: 'chunk ' } }) + '\n';
            controller.enqueue(textEncoder.encode(text));
            await new Promise((r) => setTimeout(r, 25));
          },
          cancel() {
            // Stream cancelled by reader
          }
        });

        return {
          ok: true,
          status: 200,
          body: stream,
        } as any;
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      await assert.rejects(
        async () => {
          await service.streamChat(
            'qwen2.5-coder:7b',
            [{ role: 'user', content: 'test' }],
            () => {},
            undefined,
            undefined,
            { headersTimeoutMs: 500, idleStreamTimeoutMs: 200, totalTimeoutMs: 80 }
          );
        },
        (err: any) => {
          assert.ok(err instanceof OllamaTimeoutError);
          assert.strictEqual(err.phase, 'total');
          assert.strictEqual(err.timeoutMs, 80);
          return true;
        }
      );
    });
  });

  describe('3. User Cancellation Racing & Partial History Preservation', () => {
    it('should cleanly prioritize user AbortError when user cancels before timeout triggers', async () => {
      const abortController = new AbortController();

      global.fetch = async (_url: any, options: any) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('Generation was aborted by user.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      const service = new OllamaService('http://127.0.0.1:11434');

      // Abort user signal after 20ms
      setTimeout(() => {
        abortController.abort();
      }, 20);

      await assert.rejects(
        async () => {
          await service.streamChat(
            'qwen2.5-coder:7b',
            [{ role: 'user', content: 'test' }],
            () => {},
            abortController.signal,
            undefined,
            { headersTimeoutMs: 200 }
          );
        },
        (err: any) => {
          assert.strictEqual(err.name, 'AbortError');
          assert.strictEqual(err.message, 'Generation was aborted by user.');
          return true;
        }
      );
    });

    it('should preserve partial chunks in webview when idle timeout triggers in ChatViewProvider', async () => {
      const textEncoder = new TextEncoder();

      global.fetch = async (_url: any, options: any) => {
        let sentFirst = false;
        const stream = new ReadableStream({
          async pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              const text = JSON.stringify({ message: { content: 'Partial response content before stall' } }) + '\n';
              controller.enqueue(textEncoder.encode(text));
            } else {
              await new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                  const err = new Error('aborted');
                  err.name = 'AbortError';
                  reject(err);
                });
              });
            }
          },
        });

        return {
          ok: true,
          status: 200,
          body: stream,
        } as any;
      };

      const ollama = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);

      const postedMessages: any[] = [];
      let messageHandler: ((data: any) => Promise<void>) | undefined;
      const mockWebview = {
        options: {},
        html: '',
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
          return { dispose: () => {} };
        },
        postMessage: async (msg: any) => {
          postedMessages.push(msg);
        },
      };

      provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

      // Override idleStreamTimeout in ConfigurationService for fast test
      const config = (provider as any)._ollamaService;
      assert.ok(config);

      // Mock streamChat timeouts via prototype or direct call
      const originalStreamChat = ollama.streamChat.bind(ollama);
      ollama.streamChat = (model, msgs, onChunk, sig, opts) => {
        return originalStreamChat(model, msgs, onChunk, sig, opts, {
          connectTimeoutMs: 200,
          headersTimeoutMs: 200,
          idleStreamTimeoutMs: 50,
          totalTimeoutMs: 2000,
        });
      };

      await messageHandler!({
        type: 'sendMessage',
        text: 'Tell me a story',
        mode: 'chat',
        model: 'qwen2.5-coder:7b',
      });

      // Verify posted messages
      const chunkMessages = postedMessages.filter((m) => m.type === 'streamChunk');
      assert.ok(chunkMessages.length >= 2, 'Should receive original chunk plus timeout chunk');
      assert.ok(chunkMessages[0].chunk.includes('Partial response content'));
      assert.ok(chunkMessages[1].chunk.includes('Stream timed out after'));

      // Verify streamEnd was dispatched cleanly exactly once
      const endMessages = postedMessages.filter((m) => m.type === 'streamEnd');
      assert.strictEqual(endMessages.length, 1, 'streamEnd must be dispatched exactly once');
    });

    it('should abort chatWithTools with total timeout when tools invocation hangs', async () => {
      global.fetch = (_url: any, options: any) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      const service = new OllamaService('http://127.0.0.1:11434');
      await assert.rejects(
        async () => {
          await service.chatWithTools(
            'qwen2.5-coder:7b',
            [{ role: 'user', content: 'Run tool' }],
            [],
            undefined,
            undefined,
            { headersTimeoutMs: 500, totalTimeoutMs: 60 }
          );
        },
        (err: any) => {
          assert.ok(err instanceof OllamaTimeoutError);
          assert.strictEqual(err.phase, 'total');
          assert.strictEqual(err.timeoutMs, 60);
          return true;
        }
      );
    });
  });
});
