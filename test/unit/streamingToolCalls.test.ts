import * as assert from 'assert';
import * as http from 'http';
import { OllamaService, OllamaTimeoutError, ToolChatProgress } from '../../src/services/ollamaService';
import { ToolDefinition } from '../../src/services/agentToolService';
import { nativeFetch } from '../setup';

describe('Scoped Fix: Streaming Tool Calls, Progress & Multi-Tier Timeouts Suite', () => {
  let server: http.Server;
  let serverPort: number;
  let serverEndpoint: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const originalFetch = global.fetch;

  before((done) => {
    global.fetch = nativeFetch;
    server = http.createServer((req, res) => {
      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      serverPort = addr.port;
      serverEndpoint = `http://127.0.0.1:${serverPort}`;
      done();
    });
  });

  after((done) => {
    global.fetch = originalFetch;
    server.close(done);
  });

  const dummyTool: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ping_tool',
      description: 'Ping',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      }
    }
  };

  it('should stream thinking tokens, trigger thinking progress, and accumulate tool call across chunks', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // Emit initial think tag
      res.write(JSON.stringify({ message: { role: 'assistant', content: '<think>\nAnalyzing problem...' }, done: false }) + '\n');
      setTimeout(() => {
        // Emit more thinking
        res.write(JSON.stringify({ message: { role: 'assistant', content: ' Plan formed.\n</think>\n' }, done: false }) + '\n');
        setTimeout(() => {
          // Emit tool call
          res.write(JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'ping_tool', arguments: '{"value": "pong"}' } }]
            },
            done: false
          }) + '\n');
          setTimeout(() => {
            res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
            res.end();
          }, 30);
        }, 30);
      }, 30);
    };

    const progressReports: ToolChatProgress[] = [];
    const service = new OllamaService(serverEndpoint);

    const msg = await service.chatWithTools(
      'mock-model',
      [{ role: 'user', content: 'hello' }],
      [dummyTool],
      undefined,
      { num_ctx: 2048 },
      { headersTimeoutMs: 2000, idleStreamTimeoutMs: 1000, totalTimeoutMs: 5000 },
      {
        stream: true,
        onProgress: (p) => progressReports.push(p)
      }
    );

    assert.ok(msg.tool_calls && msg.tool_calls.length === 1, 'Must extract accumulated tool call');
    assert.strictEqual(msg.tool_calls[0].function.name, 'ping_tool');
    assert.deepStrictEqual(msg.tool_calls[0].function.arguments, { value: 'pong' });

    assert.ok(progressReports.some(p => p.phase === 'thinking'), 'Must report thinking phase');
    assert.ok(progressReports.some(p => p.phase === 'streaming'), 'Must report streaming phase after thinking ends');
  });

  it('should abort with idle_stream timeout when stream stalls mid-generation', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Starting...' }, done: false }) + '\n');
      // Intentionally stall: do not emit further chunks
    };

    const service = new OllamaService(serverEndpoint);
    await assert.rejects(
      async () => {
        await service.chatWithTools(
          'mock-model',
          [{ role: 'user', content: 'test' }],
          [dummyTool],
          undefined,
          { num_ctx: 2048 },
          { headersTimeoutMs: 2000, idleStreamTimeoutMs: 80, totalTimeoutMs: 5000 },
          { stream: true }
        );
      },
      (err: any) => {
        assert.ok(err instanceof OllamaTimeoutError, `Expected OllamaTimeoutError, got ${err}`);
        assert.strictEqual(err.phase, 'idle_stream');
        assert.strictEqual(err.timeoutMs, 80);
        return true;
      }
    );
  });

  it('should succeed with slow-but-steady chunks because every chunk resets the idle timer', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let count = 0;
      const interval = setInterval(() => {
        count++;
        if (count <= 3) {
          res.write(JSON.stringify({ message: { role: 'assistant', content: `chunk_${count} ` }, done: false }) + '\n');
        } else {
          clearInterval(interval);
          res.write(JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'ping_tool', arguments: { value: 'ok' } } }]
            },
            done: true
          }) + '\n');
          res.end();
        }
      }, 40); // 40ms intervals with idleStreamTimeoutMs of 60ms
    };

    const service = new OllamaService(serverEndpoint);
    const msg = await service.chatWithTools(
      'mock-model',
      [{ role: 'user', content: 'test' }],
      [dummyTool],
      undefined,
      { num_ctx: 2048 },
      { headersTimeoutMs: 2000, idleStreamTimeoutMs: 60, totalTimeoutMs: 5000 },
      { stream: true }
    );

    assert.ok(msg.tool_calls && msg.tool_calls.length === 1);
    assert.strictEqual(msg.tool_calls[0].function.name, 'ping_tool');
  });

  it('should abort cleanly when external abort signal is triggered mid-stream', async () => {
    const abortController = new AbortController();

    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'chunk 1' }, done: false }) + '\n');
      setTimeout(() => {
        abortController.abort();
      }, 30);
    };

    const service = new OllamaService(serverEndpoint);
    await assert.rejects(
      async () => {
        await service.chatWithTools(
          'mock-model',
          [{ role: 'user', content: 'test' }],
          [dummyTool],
          abortController.signal,
          { num_ctx: 2048 },
          { headersTimeoutMs: 2000, idleStreamTimeoutMs: 2000, totalTimeoutMs: 5000 },
          { stream: true }
        );
      },
      (err: any) => {
        assert.ok(err.name === 'AbortError' || err.message.includes('aborted') || err.message.includes('Tool execution was aborted by user'));
        return true;
      }
    );
  });

  it('should parse partial tool-call JSON split across arbitrary chunk boundaries', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const rawChunk1 = '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"pi';
      const rawChunk2 = 'ng_tool","arguments":{"value":"split_boundary"}}}]},"done":false}\n';
      const rawChunk3 = '{"message":{"role":"assistant","content":""},"done":true}\n';

      res.write(rawChunk1);
      setTimeout(() => {
        res.write(rawChunk2);
        setTimeout(() => {
          res.write(rawChunk3);
          res.end();
        }, 20);
      }, 20);
    };

    const service = new OllamaService(serverEndpoint);
    const msg = await service.chatWithTools(
      'mock-model',
      [{ role: 'user', content: 'test' }],
      [dummyTool],
      undefined,
      { num_ctx: 2048 },
      { headersTimeoutMs: 2000, idleStreamTimeoutMs: 1000, totalTimeoutMs: 5000 },
      { stream: true }
    );

    assert.ok(msg.tool_calls && msg.tool_calls.length === 1);
    assert.strictEqual(msg.tool_calls[0].function.name, 'ping_tool');
    assert.strictEqual(msg.tool_calls[0].function.arguments.value, 'split_boundary');
  });

  it('should NOT extract tool call when stream contains prose mixed with JSON', async () => {
    // Real chunk sequence with leading prose
    const proseChunks = [
      'Let\'s inspect the `TaskItemsController.cs` file.\n\n',
      '{"name": "view_file_range", "arguments": {"filePath": "Backend.Api/Controllers/TaskItemsController.cs", "startLine": 1, "endLine": 50}}'
    ];

    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const ch of proseChunks) {
        res.write(JSON.stringify({
          message: { role: 'assistant', content: ch },
          done: false
        }) + '\n');
      }
      res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
      res.end();
    };

    const viewTool: ToolDefinition = {
      type: 'function',
      function: {
        name: 'view_file_range',
        description: 'View lines',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' }
          },
          required: ['filePath', 'startLine', 'endLine']
        }
      }
    };

    const service = new OllamaService(serverEndpoint);
    const msg = await service.chatWithTools(
      'qwen2.5-coder:7b',
      [{ role: 'user', content: 'inspect controller' }],
      [viewTool],
      undefined,
      { num_ctx: 2048 },
      { headersTimeoutMs: 2000, idleStreamTimeoutMs: 1000, totalTimeoutMs: 5000 },
      {
        stream: true,
        enableEmbeddedFallback: true,
        isEmbeddedCapableModel: true
      }
    );

    assert.strictEqual(msg.tool_calls, undefined, 'Must NOT extract tool call when JSON is embedded among prose');
  });

  it('should extract embedded tool call when the ENTIRE stream is exactly one JSON object with setting enabled', async () => {
    const jsonChunks = [
      '{"',
      'name',
      '":',
      ' "view_file_range",',
      ' "arguments": {',
      '"filePath": "Backend.Api/Controllers/TaskItemsController.cs",',
      '"startLine": 1,',
      '"endLine": 50',
      '}}'
    ];

    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const ch of jsonChunks) {
        res.write(JSON.stringify({
          message: { role: 'assistant', content: ch },
          done: false
        }) + '\n');
      }
      res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
      res.end();
    };

    const viewTool: ToolDefinition = {
      type: 'function',
      function: {
        name: 'view_file_range',
        description: 'View lines',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' }
          },
          required: ['filePath', 'startLine', 'endLine']
        }
      }
    };

    const service = new OllamaService(serverEndpoint);
    const msg = await service.chatWithTools(
      'qwen2.5-coder:7b',
      [{ role: 'user', content: 'inspect controller' }],
      [viewTool],
      undefined,
      { num_ctx: 2048 },
      { headersTimeoutMs: 2000, idleStreamTimeoutMs: 1000, totalTimeoutMs: 5000 },
      {
        stream: true,
        enableEmbeddedFallback: true,
        isEmbeddedCapableModel: true
      }
    );

    assert.ok(msg.tool_calls && msg.tool_calls.length === 1);
    assert.strictEqual(msg.tool_calls[0].function.name, 'view_file_range');
    assert.strictEqual(msg.tool_calls[0].function.arguments.filePath, 'Backend.Api/Controllers/TaskItemsController.cs');
  });

  it('should abort when streaming generation exceeds configured totalTimeoutMs', async () => {
    // Simulates a steadily streaming response that exceeds totalTimeoutMs (e.g. totalTimeoutMs=100ms)
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const interval = setInterval(() => {
        res.write(JSON.stringify({
          message: { role: 'assistant', content: 'steady token ' },
          done: false
        }) + '\n');
      }, 20);

      req.on('close', () => {
        clearInterval(interval);
      });
    };

    const service = new OllamaService(serverEndpoint);
    await assert.rejects(
      async () => {
        await service.chatWithTools(
          'mock-model',
          [{ role: 'user', content: 'long generation' }],
          [dummyTool],
          undefined,
          { num_ctx: 2048 },
          { headersTimeoutMs: 2000, idleStreamTimeoutMs: 2000, totalTimeoutMs: 100 }, // 100ms total timeout
          { stream: true }
        );
      },
      (err: any) => {
        assert.ok(err instanceof OllamaTimeoutError);
        assert.strictEqual(err.phase, 'total');
        assert.strictEqual(err.timeoutMs, 100);
        return true;
      }
    );
  });
});
