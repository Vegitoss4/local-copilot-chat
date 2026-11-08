import * as assert from 'assert';
import * as http from 'http';
import { OllamaService, OllamaTimeoutError } from '../../src/services/ollamaService';
import { ToolDefinition } from '../../src/services/agentToolService';
import { nativeFetch } from '../setup';

describe('Phase 12: Real HTTP Server Long Thinking & Inactivity Verification Tier', function () {
  this.timeout(250000); // 250s budget for real-time 120s delayed headers verification

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
      name: 'str_replace',
      description: 'Replace exact string in file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldStr: { type: 'string' },
          newStr: { type: 'string' }
        },
        required: ['filePath', 'oldStr', 'newStr']
      }
    }
  };

  it('tool-call request where thinking exceeds old 45s headers timeout and total generation exceeds 60s, with steady chunks, must succeed', async function () {
    // Generate thinking over 48 seconds (> 45s old headers timeout), total > 62 seconds (> 60s)
    // Emitting steady chunks every 1000ms
    const totalDurationSeconds = 62;
    const thinkingDurationSeconds = 48;

    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '<think>\n' }, done: false }) + '\n');

      let elapsedSeconds = 0;
      const interval = setInterval(() => {
        elapsedSeconds++;
        if (elapsedSeconds <= thinkingDurationSeconds) {
          // Stream thinking tokens
          res.write(JSON.stringify({
            message: { role: 'assistant', content: `Thinking step ${elapsedSeconds}...\n` },
            done: false
          }) + '\n');
        } else if (elapsedSeconds < totalDurationSeconds) {
          if (elapsedSeconds === thinkingDurationSeconds + 1) {
            res.write(JSON.stringify({ message: { role: 'assistant', content: '</think>\nPreparing tool call...\n' }, done: false }) + '\n');
          } else {
            res.write(JSON.stringify({ message: { role: 'assistant', content: `Synthesis step ${elapsedSeconds}...\n` }, done: false }) + '\n');
          }
        } else {
          // Final tool call emission
          clearInterval(interval);
          res.write(JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                function: {
                  name: 'str_replace',
                  arguments: '{"filePath": "Backend.Api/Controllers/TaskItemsController.cs", "oldStr": "```", "newStr": ""}'
                }
              }]
            },
            done: true
          }) + '\n');
          res.end();
        }
      }, 1000);

      req.on('close', () => {
        clearInterval(interval);
      });
    };

    const service = new OllamaService(serverEndpoint);
    const startTime = Date.now();

    const msg = await service.chatWithTools(
      'mock-model',
      [{ role: 'user', content: 'remove fences' }],
      [dummyTool],
      undefined,
      { num_ctx: 2048 },
      {
        headersTimeoutMs: 15000,   // Initial headers timeout is 15s (headers arrive in <100ms)
        idleStreamTimeoutMs: 5000,  // Sliding inactivity timeout is 5s (chunks arrive every 1s)
        totalTimeoutMs: 90000       // Total ceiling is 90s
      },
      { stream: true }
    );

    const elapsedMs = Date.now() - startTime;
    assert.ok(elapsedMs >= 60000, `Total generation duration should exceed 60s, got ${elapsedMs}ms`);
    assert.ok(msg.tool_calls && msg.tool_calls.length === 1, 'Must successfully return accumulated tool call');
    assert.strictEqual(msg.tool_calls[0].function.name, 'str_replace');
    assert.strictEqual(msg.tool_calls[0].function.arguments.filePath, 'Backend.Api/Controllers/TaskItemsController.cs');
  });

  it('a stall longer than the inactivity limit must fail with idle_stream timeout', async function () {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '<think>\nInitial thought...' }, done: false }) + '\n');
      // Stall: send nothing further, causing stream to exceed 1500ms inactivity limit
    };

    const service = new OllamaService(serverEndpoint);

    await assert.rejects(
      async () => {
        await service.chatWithTools(
          'mock-model',
          [{ role: 'user', content: 'test stall' }],
          [dummyTool],
          undefined,
          { num_ctx: 2048 },
          {
            headersTimeoutMs: 15000,
            idleStreamTimeoutMs: 1500, // Inactivity limit 1.5s
            totalTimeoutMs: 10000
          },
          { stream: true }
        );
      },
      (err: any) => {
        assert.ok(err instanceof OllamaTimeoutError, `Expected OllamaTimeoutError, got ${err.name}`);
        assert.strictEqual(err.phase, 'idle_stream', `Expected phase idle_stream, got ${err.phase}`);
        return true;
      }
    );
  });

  it('tool-call request with delayed headers of 60s must succeed when under headers timeout limit', async function () {
    const delayMs = 60000;
    handler = (req, res) => {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              function: {
                name: 'str_replace',
                arguments: '{"filePath": "TaskItemsController.cs", "oldStr": "```", "newStr": ""}'
              }
            }]
          },
          done: true
        }) + '\n');
        res.end();
      }, delayMs);

      req.on('close', () => clearTimeout(timer));
    };

    const service = new OllamaService(serverEndpoint);
    const start = Date.now();

    const msg = await service.chatWithTools(
      'mock-model',
      [{ role: 'user', content: 'test 60s headers delay' }],
      [dummyTool],
      undefined,
      { num_ctx: 2048 },
      {
        headersTimeoutMs: 75000, // 75s > 60s
        idleStreamTimeoutMs: 15000,
        totalTimeoutMs: 90000
      },
      { stream: true }
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 59000, `Expected elapsed >= 59s, got ${elapsed}ms`);
    assert.ok(msg.tool_calls && msg.tool_calls.length === 1);
    assert.strictEqual(msg.tool_calls[0].function.name, 'str_replace');
  });

  it('tool-call request with delayed headers of 120s must succeed when under headers timeout limit', async function () {
    const delayMs = 120000;
    handler = (req, res) => {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              function: {
                name: 'str_replace',
                arguments: '{"filePath": "TaskItemsController.cs", "oldStr": "```", "newStr": ""}'
              }
            }]
          },
          done: true
        }) + '\n');
        res.end();
      }, delayMs);

      req.on('close', () => clearTimeout(timer));
    };

    const service = new OllamaService(serverEndpoint);
    const start = Date.now();

    const msg = await service.chatWithTools(
      'mock-model',
      [{ role: 'user', content: 'test 120s headers delay' }],
      [dummyTool],
      undefined,
      { num_ctx: 2048 },
      {
        headersTimeoutMs: 135000, // 135s > 120s
        idleStreamTimeoutMs: 15000,
        totalTimeoutMs: 150000
      },
      { stream: true }
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 119000, `Expected elapsed >= 119s, got ${elapsed}ms`);
    assert.ok(msg.tool_calls && msg.tool_calls.length === 1);
    assert.strictEqual(msg.tool_calls[0].function.name, 'str_replace');
  });

  it('delayed headers exceeding hard first-byte limit must fail with headers timeout', async function () {
    handler = (req, res) => {
      // Server holds headers for 5s, but client limit is 1.5s
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end();
      }, 5000);
      req.on('close', () => clearTimeout(timer));
    };

    const service = new OllamaService(serverEndpoint);

    await assert.rejects(
      async () => {
        await service.chatWithTools(
          'mock-model',
          [{ role: 'user', content: 'test headers limit exceeded' }],
          [dummyTool],
          undefined,
          { num_ctx: 2048 },
          {
            headersTimeoutMs: 1500, // 1.5s limit
            idleStreamTimeoutMs: 10000,
            totalTimeoutMs: 10000
          },
          { stream: true }
        );
      },
      (err: any) => {
        assert.ok(err instanceof OllamaTimeoutError, `Expected OllamaTimeoutError, got ${err.name}`);
        assert.strictEqual(err.phase, 'headers', `Expected phase headers, got ${err.phase}`);
        return true;
      }
    );
  });
});
