import * as assert from 'assert';
import { ConfigurationService, CONFIG_DEFAULTS, CONFIG_BOUNDS } from '../../src/services/configurationService';
import { OllamaService } from '../../src/services/ollamaService';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { SwarmOrchestrator } from '../../src/services/swarmOrchestrator';
import { AutonomousAgent } from '../../src/services/autonomousAgent';
import { resetMockState, updateMockConfiguration, MockUri } from '../mocks/vscodeMock';

describe('Deliverable A3: Runtime Configuration Settings Suite', () => {
  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
    ConfigurationService.resetInstance();
  });

  afterEach(() => {
    ConfigurationService.resetInstance();
    resetMockState('C:/Projects/test-workspace');
  });

  describe('1. ConfigurationService Defaults', () => {
    it('should return system default values when no configuration is set', () => {
      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.ollamaEndpoint, CONFIG_DEFAULTS.ollamaEndpoint);
      assert.strictEqual(config.defaultModel, CONFIG_DEFAULTS.defaultModel);
      assert.strictEqual(config.numCtx, 16384);
      assert.strictEqual(config.temperature, 0.2);
      assert.strictEqual(config.maxTurns, 25);
    });

    it('should return all defaults in getConfig() snapshot', () => {
      const config = ConfigurationService.getInstance();
      const snapshot = config.getConfig();

      assert.deepStrictEqual(snapshot, {
        ollamaEndpoint: 'http://127.0.0.1:11434',
        defaultModel: 'qwen2.5-coder:7b',
        numCtx: 16384,
        temperature: 0.2,
        maxTurns: 25,
        connectTimeout: 5000,
        idleStreamTimeout: 30000,
        totalGenerationTimeout: 300000,
        modelUnloadPolicy: 'keepAlive',
        modelKeepAliveDuration: '5m',
        idleUnloadTimeout: 180000,
        warnOnCpuOffload: true,
        routerEnabled: false,
        benchmarkRepetitions: 3,
        enableStructuredEditFallback: true,
        suggestAgentModeOnEditIntent: true,
        minExplorationBeforeAsk: 3,
        maxClarificationQuestionsPerTask: 2,
        enableWorkspaceDiscoveryPreStep: true,
        streamToolCalls: true,
        enableEmbeddedToolCallFallback: false,
        headersTimeout: 45000,
        roleModels: {},
        disableThinking: false,
        absoluteMaxTimeoutMs: 900000,
        keepGoingGracePeriodMs: 30000,
        maxPriorTurns: 6,
        tokenBudget: 4000,
        enableLlmSummary: false,
        decomposeMultiPhaseSpecs: true,
        enforceFileWritesForImplementation: true,
      });
    });
  });

  describe('2. Valid Configuration Overrides', () => {
    it('should correctly reflect valid user-configured overrides', () => {
      updateMockConfiguration('localCopilot.numCtx', 8192);
      updateMockConfiguration('localCopilot.temperature', 0.7);
      updateMockConfiguration('localCopilot.maxTurns', 15);
      updateMockConfiguration('localCopilot.defaultModel', 'deepseek-r1:8b');
      updateMockConfiguration('localCopilot.ollamaEndpoint', 'http://192.168.1.100:11434');

      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.numCtx, 8192);
      assert.strictEqual(config.temperature, 0.7);
      assert.strictEqual(config.maxTurns, 15);
      assert.strictEqual(config.defaultModel, 'deepseek-r1:8b');
      assert.strictEqual(config.ollamaEndpoint, 'http://192.168.1.100:11434');
    });
  });

  describe('3. Boundary Clamping', () => {
    it('should clamp under-bound values to their defined minimums', () => {
      updateMockConfiguration('localCopilot.numCtx', 1000); // min: 2048
      updateMockConfiguration('localCopilot.temperature', -0.5); // min: 0.0
      updateMockConfiguration('localCopilot.maxTurns', 0); // min: 1

      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.numCtx, CONFIG_BOUNDS.numCtx.min);
      assert.strictEqual(config.temperature, CONFIG_BOUNDS.temperature.min);
      assert.strictEqual(config.maxTurns, CONFIG_BOUNDS.maxTurns.min);
    });

    it('should clamp negative turns to minimum 1', () => {
      updateMockConfiguration('localCopilot.maxTurns', -10);

      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.maxTurns, 1);
    });

    it('should clamp over-bound values to their defined maximums', () => {
      updateMockConfiguration('localCopilot.numCtx', 100000); // max: 65536
      updateMockConfiguration('localCopilot.temperature', 2.5); // max: 1.0
      updateMockConfiguration('localCopilot.maxTurns', 200); // max: 100

      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.numCtx, CONFIG_BOUNDS.numCtx.max);
      assert.strictEqual(config.temperature, CONFIG_BOUNDS.temperature.max);
      assert.strictEqual(config.maxTurns, CONFIG_BOUNDS.maxTurns.max);
    });
  });

  describe('4. Non-Numeric, NaN, and Infinite Values', () => {
    it('should fall back to safe defaults for non-numeric types', () => {
      updateMockConfiguration('localCopilot.numCtx', 'invalid');
      updateMockConfiguration('localCopilot.temperature', 'warm');
      updateMockConfiguration('localCopilot.maxTurns', true);

      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.numCtx, CONFIG_DEFAULTS.numCtx);
      assert.strictEqual(config.temperature, CONFIG_DEFAULTS.temperature);
      assert.strictEqual(config.maxTurns, CONFIG_DEFAULTS.maxTurns);
    });

    it('should fall back to safe defaults for NaN and Infinity', () => {
      updateMockConfiguration('localCopilot.numCtx', NaN);
      updateMockConfiguration('localCopilot.temperature', Infinity);
      updateMockConfiguration('localCopilot.maxTurns', -Infinity);

      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.numCtx, CONFIG_DEFAULTS.numCtx);
      assert.strictEqual(config.temperature, CONFIG_DEFAULTS.temperature);
      assert.strictEqual(config.maxTurns, CONFIG_DEFAULTS.maxTurns);
    });

    it('should fall back to defaultModel for empty strings or non-string values', () => {
      updateMockConfiguration('localCopilot.defaultModel', '   ');
      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.defaultModel, CONFIG_DEFAULTS.defaultModel);
    });
  });

  describe('5. Integer Truncation for Discontinuous Settings', () => {
    it('should floor non-integer values for integer settings', () => {
      updateMockConfiguration('localCopilot.numCtx', 8192.9);
      updateMockConfiguration('localCopilot.maxTurns', 12.8);

      const config = ConfigurationService.getInstance();

      assert.strictEqual(config.numCtx, 8192);
      assert.strictEqual(config.maxTurns, 12);
    });

    it('should preserve fractional values for temperature', () => {
      updateMockConfiguration('localCopilot.temperature', 0.35);

      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.temperature, 0.35);
    });
  });

  describe('6. Endpoint Normalization and Protocol Hardening', () => {
    it('should strip trailing slashes and trim whitespace from endpoints', () => {
      updateMockConfiguration('localCopilot.ollamaEndpoint', '  http://127.0.0.1:11434///  ');

      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.ollamaEndpoint, 'http://127.0.0.1:11434');
    });

    it('should allow valid HTTPS endpoints', () => {
      updateMockConfiguration('localCopilot.ollamaEndpoint', 'https://remote-ollama.internal:8443/');

      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.ollamaEndpoint, 'https://remote-ollama.internal:8443');
    });

    it('should reject non-HTTP/HTTPS protocols and fall back to default', () => {
      updateMockConfiguration('localCopilot.ollamaEndpoint', 'ftp://127.0.0.1:11434');

      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.ollamaEndpoint, CONFIG_DEFAULTS.ollamaEndpoint);
    });

    it('should reject malformed or non-URL strings and fall back to default', () => {
      updateMockConfiguration('localCopilot.ollamaEndpoint', 'not-a-valid-url:::');

      const config = ConfigurationService.getInstance();
      assert.strictEqual(config.ollamaEndpoint, CONFIG_DEFAULTS.ollamaEndpoint);
    });
  });

  describe('7. Configuration Change Events', () => {
    it('should fire onDidChangeEndpoint when ollamaEndpoint changes', () => {
      const config = ConfigurationService.getInstance();
      const events: string[] = [];

      config.onDidChangeEndpoint((newEndpoint) => {
        events.push(newEndpoint);
      });

      updateMockConfiguration('localCopilot.ollamaEndpoint', 'http://localhost:11435');

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0], 'http://localhost:11435');
    });

    it('should not fire onDidChangeEndpoint if new endpoint normalizes to identical value', () => {
      const config = ConfigurationService.getInstance();
      const events: string[] = [];

      config.onDidChangeEndpoint((newEndpoint) => {
        events.push(newEndpoint);
      });

      // Same normalized endpoint with trailing slash and whitespace
      updateMockConfiguration('localCopilot.ollamaEndpoint', 'http://127.0.0.1:11434/  ');

      assert.strictEqual(events.length, 0);
    });

    it('should fire onDidChangeConfig when any localCopilot setting is updated', () => {
      const config = ConfigurationService.getInstance();
      let firedCount = 0;

      config.onDidChangeConfig((newConfig) => {
        firedCount++;
        assert.strictEqual(newConfig.temperature, 0.5);
      });

      updateMockConfiguration('localCopilot.temperature', 0.5);
      assert.strictEqual(firedCount, 1);
    });
  });

  describe('8. ChatViewProvider Wiring & Consumer Behavior', () => {
    it('should update ollamaService endpoint and fetch models via handleEndpointChange', async () => {
      const originalFetch = global.fetch;
      try {
        let fetchedUrl = '';
        global.fetch = async (url: any) => {
          fetchedUrl = String(url);
          return {
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] }),
          } as any;
        };

        const service = new OllamaService('http://127.0.0.1:11434');
        const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
        const postedMessages: any[] = [];
        (provider as any)._view = {
          webview: {
            postMessage: async (m: any) => { postedMessages.push(m); }
          }
        };

        provider.handleEndpointChange('http://custom-host:11434');

        assert.strictEqual(service.getEndpoint(), 'http://custom-host:11434');
        // Let async fetch finish
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(fetchedUrl.startsWith('http://custom-host:11434/api/tags'));
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should pass configured numCtx and temperature to streamChat in chat mode', async () => {
      updateMockConfiguration('localCopilot.numCtx', 8192);
      updateMockConfiguration('localCopilot.temperature', 0.4);

      let capturedOptions: any = null;
      const mockOllamaService = {
        getEndpoint: () => 'http://127.0.0.1:11434',
        setEndpoint: () => {},
        getAvailableModels: async () => ['qwen2.5-coder:7b'],
        resolveModelForRole: (_role: any, fallback: string) => fallback,
        resolveModelForPhase: (_phase: any, fallback: string) => fallback,
        streamChat: async (_model: string, _msgs: any[], onChunk: any, _signal: any, options: any) => {
          capturedOptions = options;
          onChunk('Hello!');
          return 'Hello!';
        }
      } as any;

      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, mockOllamaService);
      const postedMessages: any[] = [];
      (provider as any)._view = {
        webview: {
          postMessage: async (m: any) => { postedMessages.push(m); }
        }
      };

      await (provider as any)._handleSendMessage('Hello test', 'qwen2.5-coder:7b', 'chat', true);

      assert.ok(capturedOptions, 'Expected options to be passed to streamChat');
      assert.strictEqual(capturedOptions.num_ctx, 8192);
      assert.strictEqual(capturedOptions.temperature, 0.4);
    });
  });

  describe('9. Agent Mode Tool Calling Determinism & Dynamic Compaction', () => {
    it('should enforce deterministic temperature ceiling (<= 0.1) on tool calling in SwarmOrchestrator', async () => {
      let passedOptions: any = null;
      const mockOllamaService = {
        getEndpoint: () => 'http://127.0.0.1:11434',
        setEndpoint: () => {},
        unloadModel: async () => {},
        resolveModelForRole: (_role: any, fallback: string) => fallback,
        chatWithTools: async (_model: string, _msgs: any[], _tools: any[], _signal: any, options: any) => {
          passedOptions = options;
          return { role: 'assistant', content: 'Task completed directly.' };
        }
      } as any;

      // User configured high temperature (0.8)
      const orchestrator = new SwarmOrchestrator(mockOllamaService, {
        maxTurns: 10,
        numCtx: 8192,
        temperature: 0.8,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      await orchestrator.runTask('Do task', {});

      assert.ok(passedOptions, 'Expected options to be passed to chatWithTools');
      assert.strictEqual(passedOptions.num_ctx, 8192);
      // Tool calling temperature must be capped at 0.1 even if user configured 0.8
      assert.strictEqual(passedOptions.temperature, 0.1);
    });

    it('should dynamically scale context compaction threshold in SwarmOrchestrator based on numCtx', () => {
      const mockOllamaService = {} as any;
      const orchestrator = new SwarmOrchestrator(mockOllamaService, {
        maxTurns: 10,
        numCtx: 4096, // 4096 * 2.5 = 10240 characters
        temperature: 0.2,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      // Initialize whiteboard
      (orchestrator as any).whiteboard = {
        executionPlan: null,
        modifiedFiles: [],
        toolOutputs: [],
        sharedFindings: [],
      };

      // Create history with 8 messages, total chars ~12000 (> 10240)
      const history = [
        { role: 'system', content: 'system message' },
        { role: 'user', content: 'initial user query' },
        { role: 'assistant', content: 'x'.repeat(3000) },
        { role: 'tool', content: 'x'.repeat(3000) },
        { role: 'assistant', content: 'x'.repeat(3000) },
        { role: 'tool', content: 'x'.repeat(3000) },
        { role: 'assistant', content: 'recent turn 1' },
        { role: 'user', content: 'recent turn 2' },
      ];

      (orchestrator as any).orchestratorHistory = history;
      (orchestrator as any).compactContext(history);

      const compacted = (orchestrator as any).orchestratorHistory;
      // System (1) + User (1) + Summary (1) + Recent Turns (4) = 7
      assert.strictEqual(compacted.length, 7);
      assert.ok(compacted[2].content.includes('compacted'));
    });

    it('should respect maxTurns setting in SwarmOrchestrator', async () => {
      let turnCount = 0;
      const mockOllamaService = {
        getEndpoint: () => 'http://127.0.0.1:11434',
        setEndpoint: () => {},
        unloadModel: async () => {},
        resolveModelForRole: (_role: any, fallback: string) => fallback,
        chatWithTools: async () => {
          turnCount++;
          // Never return final answer, always return empty content to simulate ongoing execution
          return { role: 'assistant', content: '', tool_calls: [] };
        }
      } as any;

      const orchestrator = new SwarmOrchestrator(mockOllamaService, {
        maxTurns: 3,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      const result = await orchestrator.runTask('Infinite task', {});
      assert.strictEqual(turnCount, 3);
      assert.ok(result.includes('maximum execution turns (3)'));
    });

    it('should support legacy maxTurns and temperature ceiling in AutonomousAgent', async () => {
      let passedOptions: any = null;
      let turns = 0;
      const mockOllamaService = {
        getEndpoint: () => 'http://127.0.0.1:11434',
        setEndpoint: () => {},
        resolveModelForPhase: (_phase: any, fallback: string) => fallback,
        chatWithTools: async (_model: string, _msgs: any[], _tools: any[], _signal: any, options: any) => {
          passedOptions = options;
          turns++;
          return { role: 'assistant', content: 'Done' };
        }
      } as any;

      const agent = new AutonomousAgent(mockOllamaService, {
        maxTurns: 5,
        numCtx: 4096,
        temperature: 0.6,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      await agent.runTask('Test legacy agent', {});

      assert.ok(passedOptions);
      assert.strictEqual(passedOptions.num_ctx, 4096);
      assert.strictEqual(passedOptions.temperature, 0.1);
      assert.strictEqual((agent as any).maxIterations, 5);
    });
  });
});
