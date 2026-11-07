import * as assert from 'assert';
import * as http from 'http';
import { OllamaService, OllamaTimeoutError } from '../../src/services/ollamaService';
import { nativeFetch } from '../setup';

describe('Phase 8.1d: Real HTTP Server Socket & Streaming Inactivity Timeouts Tier', function () {
  this.timeout(10000);

  let originalFetch: any;
  let server: http.Server | undefined;
  let serverPort: number;
  let serverUrl: string;

  beforeEach(() => {
    originalFetch = global.fetch;
    if (nativeFetch) {
      global.fetch = nativeFetch;
    }
  });

  afterEach((done) => {
    global.fetch = originalFetch;
    if (server) {
      server.close(() => {
        server = undefined;
        done();
      });
    } else {
      done();
    }
  });

  it('should timeout when server delays responding with headers (headers timeout)', async () => {
    server = http.createServer((_req, res) => {
      // Intentionally do not send headers immediately
      setTimeout(() => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: 'late' } }));
        } catch {
          // Socket might have closed
        }
      }, 500);
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as any;
    serverPort = addr.port;
    serverUrl = `http://127.0.0.1:${serverPort}`;

    const service = new OllamaService(serverUrl);

    let errorThrown: any = null;
    try {
      await service.streamChat(
        'test-model',
        [{ role: 'user', content: 'hi' }],
        () => {},
        undefined,
        {},
        { headersTimeoutMs: 150, connectTimeoutMs: 150 }
      );
    } catch (err: any) {
      errorThrown = err;
    }

    assert.ok(errorThrown, 'Expected timeout error was not thrown');
    assert.ok(
      errorThrown instanceof OllamaTimeoutError,
      `Expected OllamaTimeoutError, got ${errorThrown?.name}: ${errorThrown?.message}`
    );
    assert.strictEqual(errorThrown.phase, 'headers');
  });

  it('should abort when stream stalls mid-generation (idle stream timeout)', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Part 1... ' } }) + '\n');
      // Then stall without sending end or further chunks
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as any;
    serverPort = addr.port;
    serverUrl = `http://127.0.0.1:${serverPort}`;

    const service = new OllamaService(serverUrl);
    const chunks: string[] = [];

    let errorThrown: any = null;
    try {
      await service.streamChat(
        'test-model',
        [{ role: 'user', content: 'hi' }],
        (chunk: string) => chunks.push(chunk),
        undefined,
        {},
        { idleStreamTimeoutMs: 150, headersTimeoutMs: 1000 }
      );
    } catch (err: any) {
      errorThrown = err;
    }

    assert.ok(errorThrown, 'Expected idle stream timeout error was not thrown');
    assert.ok(
      errorThrown instanceof OllamaTimeoutError,
      `Expected OllamaTimeoutError, got ${errorThrown?.name}: ${errorThrown?.message}`
    );
    assert.strictEqual(errorThrown.phase, 'idle_stream');
    assert.deepStrictEqual(chunks, ['Part 1... ']);
  });

  it('should succeed when chunks arrive periodically, resetting idle timer on each chunk', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // Send 3 chunks at 80ms intervals (total ~240ms > idleStreamTimeoutMs of 140ms)
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'A' } }) + '\n');
      setTimeout(() => {
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'B' } }) + '\n');
        setTimeout(() => {
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'C' } }) + '\n');
          res.end();
        }, 80);
      }, 80);
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as any;
    serverPort = addr.port;
    serverUrl = `http://127.0.0.1:${serverPort}`;

    const service = new OllamaService(serverUrl);
    const chunks: string[] = [];

    const result = await service.streamChat(
      'test-model',
      [{ role: 'user', content: 'hi' }],
      (chunk: string) => chunks.push(chunk),
      undefined,
      {},
      { idleStreamTimeoutMs: 140, headersTimeoutMs: 1000 }
    );

    assert.strictEqual(result, 'ABC');
    assert.deepStrictEqual(chunks, ['A', 'B', 'C']);
  });

  it('should immediately abort streaming when client abort controller triggers', async () => {
    let clientDisconnected = false;

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      req.on('close', () => {
        clientDisconnected = true;
      });

      const interval = setInterval(() => {
        try {
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'tick ' } }) + '\n');
        } catch {
          clearInterval(interval);
        }
      }, 40);

      req.on('close', () => clearInterval(interval));
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as any;
    serverPort = addr.port;
    serverUrl = `http://127.0.0.1:${serverPort}`;

    const service = new OllamaService(serverUrl);
    const abortController = new AbortController();
    let receivedChunks = 0;

    let abortedError: any = null;
    try {
      await service.streamChat(
        'test-model',
        [{ role: 'user', content: 'hi' }],
        (_chunk: string) => {
          receivedChunks++;
          if (receivedChunks >= 1) {
            abortController.abort();
          }
        },
        abortController.signal,
        {},
        { headersTimeoutMs: 1000 }
      );
    } catch (err: any) {
      abortedError = err;
    }

    assert.ok(abortedError, 'Expected AbortError was not thrown');
    assert.strictEqual(abortedError.name, 'AbortError');

    // Give a short grace period for the socket close event to register on the server
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(clientDisconnected, true, 'Server did not receive close notification from aborted socket');
  });
});
