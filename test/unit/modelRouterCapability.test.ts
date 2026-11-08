import * as assert from 'assert';
import { ModelRouter, RouteDecision } from '../../src/services/modelRouter';
import { ModelCapabilityResult, ModelProbeResult } from '../../src/services/ollamaService';

describe('Scoped Fix B: ModelRouter Tool Capability & Pinned Model Validation Suite', () => {
  const toolModelCap: ModelCapabilityResult = {
    model: 'qwen2.5-coder:7b',
    hasTools: true,
    capabilities: ['completion', 'tools', 'insert'],
    status: 'supported'
  };

  const nonToolModelCap: ModelCapabilityResult = {
    model: 'deepseek-r1:8b',
    hasTools: false,
    capabilities: ['completion', 'thinking'],
    status: 'unsupported'
  };

  const unknownModelCap: ModelCapabilityResult = {
    model: 'custom-experimental:latest',
    hasTools: false,
    capabilities: [],
    status: 'unknown'
  };

  it('Agent mode Auto MUST choose ONLY models whose capabilities include tools', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['deepseek-r1:8b', nonToolModelCap],
      ['qwen2.5-coder:7b', toolModelCap]
    ]);

    // Available models listed deepseek-r1:8b first, but Agent mode must select qwen2.5-coder:7b
    const decision = ModelRouter.classifyIntent(
      'Fix the backend build',
      'agent',
      ['deepseek-r1:8b', 'qwen2.5-coder:7b'],
      capsMap
    );

    assert.strictEqual(decision.model, 'qwen2.5-coder:7b');
    assert.strictEqual(decision.hasTools, true);
    assert.ok(decision.reason.includes('tool-capable'));
  });

  it('Agent mode Auto must NEVER pick a non-tool model when all models lack tools', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['deepseek-r1:8b', nonToolModelCap],
      ['llama2:7b', { model: 'llama2:7b', hasTools: false, capabilities: ['completion'], status: 'unsupported' }]
    ]);

    const decision = ModelRouter.classifyIntent(
      'Implement feature',
      'agent',
      ['deepseek-r1:8b', 'llama2:7b'],
      capsMap
    );

    assert.strictEqual(decision.model, '', 'Must not pick any model when all lack tools');
    assert.strictEqual(decision.hasTools, false);
    assert.ok(decision.actionableMessage, 'Must provide actionable message');
    assert.ok(decision.reason.includes('No installed models declare tool-calling'));
  });

  it('Agent mode must report when capabilities are unknown', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['custom-experimental:latest', unknownModelCap]
    ]);

    const decision = ModelRouter.classifyIntent(
      'Fix build',
      'agent',
      ['custom-experimental:latest'],
      capsMap
    );

    assert.strictEqual(decision.isCapabilityUnknown, true);
    assert.ok(decision.reason.includes('Capabilities unknown'));
  });

  it('Chat mode Auto routes based on intent without requiring tools', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['deepseek-r1:8b', nonToolModelCap],
      ['qwen2.5-coder:7b', toolModelCap]
    ]);

    // Reasoning prompt in Chat mode should route to deepseek-r1:8b even though it lacks tools
    const decision = ModelRouter.classifyIntent(
      'Explain the architecture and why this design was chosen',
      'chat',
      ['deepseek-r1:8b', 'qwen2.5-coder:7b'],
      capsMap
    );

    assert.strictEqual(decision.model, 'deepseek-r1:8b');
    assert.strictEqual(decision.intent, 'reasoning');
  });

  it('validatePinnedModel returns actionable alternatives and fallback notice for non-tool model', () => {
    const installedToolModels = ['qwen2.5-coder:7b', 'qwen3.5:9b'];
    const validation = ModelRouter.validatePinnedModel('deepseek-r1:8b', nonToolModelCap, installedToolModels);

    assert.strictEqual(validation.valid, false);
    assert.ok(validation.actionableMessage?.includes('deepseek-r1:8b'));
    assert.ok(validation.actionableMessage?.includes('qwen2.5-coder:7b'));
    assert.ok(validation.fallbackNotice?.includes('structured-edit fallback'));
  });

  it('validatePinnedModel succeeds for verified tool-capable model', () => {
    const installedToolModels = ['qwen2.5-coder:7b'];
    const validation = ModelRouter.validatePinnedModel('qwen2.5-coder:7b', toolModelCap, installedToolModels);

    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.actionableMessage, undefined);
  });

  it('fails closed when model declares tools in capabilities but fails behavioral probe', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['flaky-model:latest', { model: 'flaky-model:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }]
    ]);
    const probesMap = new Map<string, ModelProbeResult>([
      ['flaky-model:latest', { model: 'flaky-model:latest', supported: false, emittedNativeCalls: false, emittedContentCalls: false, latencyMs: 500, probedAt: Date.now() }]
    ]);

    const decision = ModelRouter.classifyIntent(
      'Fix the backend bug',
      'agent',
      ['flaky-model:latest'],
      capsMap,
      probesMap
    );

    assert.strictEqual(decision.model, '', 'Must fail closed when probe fails');
    assert.strictEqual(decision.hasTools, false);
    assert.ok(decision.reason.includes('No installed models declare tool-calling capability and pass behavioral probe'));
  });

  it('validatePinnedModel reports behavioral probe failure and suggests alternatives', () => {
    const probeFail: ModelProbeResult = {
      model: 'flaky-model:latest',
      supported: false,
      emittedNativeCalls: false,
      emittedContentCalls: false,
      latencyMs: 1200,
      probedAt: Date.now()
    };

    const validation = ModelRouter.validatePinnedModel(
      'flaky-model:latest',
      { model: 'flaky-model:latest', hasTools: true, capabilities: ['tools'], status: 'supported' },
      ['qwen2.5-coder:7b'],
      probeFail
    );

    assert.strictEqual(validation.valid, false);
    assert.ok(validation.actionableMessage?.includes('failed the active behavioral tool probe'));
    assert.ok(validation.actionableMessage?.includes('qwen2.5-coder:7b'));
    assert.ok(validation.fallbackNotice?.includes('structured-edit fallback'));
  });

  it('ranks candidates by empirical profile tool reliability and measured TPS', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['model-alpha:latest', { model: 'model-alpha:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }],
      ['model-beta:latest', { model: 'model-beta:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }]
    ]);

    const profilesMap = new Map([
      ['model-alpha:latest', {
        modelTag: 'model-alpha:latest',
        measuredTps: 18.0,
        vramBytes: 4 * 1024 * 1024 * 1024,
        effectiveContextTokens: 4096,
        toolCallReliability: 0.60,
        categoryStrengths: { code_repair: 50 },
        swapCostMs: 2000
      }],
      ['model-beta:latest', {
        modelTag: 'model-beta:latest',
        measuredTps: 45.0,
        vramBytes: 4 * 1024 * 1024 * 1024,
        effectiveContextTokens: 8192,
        toolCallReliability: 0.98,
        categoryStrengths: { code_repair: 95 },
        swapCostMs: 2000
      }]
    ]);

    const decision = ModelRouter.classifyIntent(
      'Fix the backend build and implement endpoints',
      'agent',
      ['model-alpha:latest', 'model-beta:latest'],
      capsMap,
      undefined,
      profilesMap
    );

    assert.strictEqual(decision.model, 'model-beta:latest', 'Must rank model-beta higher due to superior empirical tool reliability and TPS');
    assert.strictEqual(decision.hasTools, true);
    assert.ok(decision.reason.includes('tool reliability 98%'));
  });

  it('ranks candidates by behavioral probe native execution when capabilities tie', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['candidate-a:latest', { model: 'candidate-a:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }],
      ['candidate-b:latest', { model: 'candidate-b:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }]
    ]);

    const probesMap = new Map<string, ModelProbeResult>([
      ['candidate-a:latest', {
        model: 'candidate-a:latest',
        supported: true,
        emittedNativeCalls: false,
        emittedContentCalls: true,
        latencyMs: 1200,
        probedAt: Date.now()
      }],
      ['candidate-b:latest', {
        model: 'candidate-b:latest',
        supported: true,
        emittedNativeCalls: true,
        emittedContentCalls: false,
        latencyMs: 800,
        probedAt: Date.now()
      }]
    ]);

    const decision = ModelRouter.classifyIntent(
      'Fix the backend build and implement endpoints',
      'agent',
      ['candidate-a:latest', 'candidate-b:latest'],
      capsMap,
      probesMap
    );

    assert.strictEqual(decision.model, 'candidate-b:latest', 'Must rank native tool caller higher than content-fallback model');
    assert.strictEqual(decision.hasTools, true);
    assert.ok(decision.reason.includes('native tools'));
  });

  it('preserves user pinned model when no ranking data differentiates candidates', () => {
    const capsMap = new Map<string, ModelCapabilityResult>([
      ['model-one:latest', { model: 'model-one:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }],
      ['model-two:latest', { model: 'model-two:latest', hasTools: true, capabilities: ['tools'], status: 'supported' }]
    ]);

    const decision = ModelRouter.classifyIntent(
      'Fix the backend build and implement endpoints',
      'agent',
      ['model-one:latest', 'model-two:latest'],
      capsMap,
      undefined,
      undefined,
      'model-two:latest'
    );

    assert.strictEqual(decision.model, 'model-two:latest', 'Must preserve user pinned model when no profile or probe differentiates');
    assert.strictEqual(decision.hasTools, true);
    assert.ok(decision.reason.includes('preserving user-selected model "model-two:latest"'));
  });

  describe('Realistic 4-Model Fixture Tier (/api/show declarations)', () => {
    // Realistic fixtures corresponding to the 4 installed local Ollama models:
    const nomicEmbedCap: ModelCapabilityResult = {
      model: 'nomic-embed-text:latest',
      hasTools: false,
      capabilities: ['embedding'],
      status: 'unsupported'
    };

    const coderCap: ModelCapabilityResult = {
      model: 'qwen2.5-coder:7b',
      hasTools: true,
      capabilities: ['completion', 'tools', 'insert'],
      status: 'supported'
    };

    const qwen35Cap: ModelCapabilityResult = {
      model: 'qwen3.5:9b',
      hasTools: true,
      capabilities: ['completion', 'vision', 'tools', 'thinking'],
      status: 'supported'
    };

    const deepseekCap: ModelCapabilityResult = {
      model: 'deepseek-r1:8b',
      hasTools: false,
      capabilities: ['completion', 'thinking'],
      status: 'unsupported'
    };

    const realisticCaps = new Map<string, ModelCapabilityResult>([
      ['nomic-embed-text:latest', nomicEmbedCap],
      ['qwen2.5-coder:7b', coderCap],
      ['qwen3.5:9b', qwen35Cap],
      ['deepseek-r1:8b', deepseekCap]
    ]);

    it('an embedding-only model is never a chat or agent candidate', () => {
      const allFour = ['nomic-embed-text:latest', 'qwen2.5-coder:7b', 'qwen3.5:9b', 'deepseek-r1:8b'];

      // Agent mode test
      const agentDecision = ModelRouter.classifyIntent(
        'Implement repository layer',
        'agent',
        allFour,
        realisticCaps
      );
      assert.notStrictEqual(agentDecision.model, 'nomic-embed-text:latest', 'Embedding model must never be selected in Agent mode');
      assert.ok(agentDecision.hasTools, 'Selected model must be tool-capable');

      // Chat mode test with embedding-only model listed first
      const chatDecision = ModelRouter.classifyIntent(
        'Hello, can you help me write code?',
        'chat',
        allFour,
        realisticCaps
      );
      assert.notStrictEqual(chatDecision.model, 'nomic-embed-text:latest', 'Embedding model must never be selected in Chat mode');

      // Chat mode when ONLY embedding model is available
      const onlyEmbeddingDecision = ModelRouter.classifyIntent(
        'What is this project?',
        'chat',
        ['nomic-embed-text:latest'],
        realisticCaps
      );
      assert.strictEqual(onlyEmbeddingDecision.model, '', 'Must return empty model when only embedding-only models exist');
    });

    it('Auto in Agent mode never selects a model that failed the probe', () => {
      // Both qwen2.5-coder and qwen3.5 declare tools in /api/show, but qwen2.5-coder fails probe
      const probesMap = new Map<string, ModelProbeResult>([
        ['qwen2.5-coder:7b', {
          model: 'qwen2.5-coder:7b',
          supported: false,
          emittedNativeCalls: false,
          emittedContentCalls: false,
          latencyMs: 1500,
          probedAt: Date.now()
        }],
        ['qwen3.5:9b', {
          model: 'qwen3.5:9b',
          supported: true,
          emittedNativeCalls: true,
          emittedContentCalls: false,
          latencyMs: 800,
          probedAt: Date.now()
        }]
      ]);

      const decision = ModelRouter.classifyIntent(
        'Fix the bug in TaskItemsController.cs',
        'agent',
        ['qwen2.5-coder:7b', 'qwen3.5:9b'],
        realisticCaps,
        probesMap
      );

      assert.strictEqual(decision.model, 'qwen3.5:9b', 'Must NOT select model that failed probe');
      assert.strictEqual(decision.hasTools, true);
    });

    it('with no ranking data to differentiate models, the pinned model is kept and reason is shown', () => {
      const decision = ModelRouter.classifyIntent(
        'Build the project and run tests',
        'agent',
        ['qwen2.5-coder:7b', 'qwen3.5:9b'],
        realisticCaps,
        undefined,
        undefined,
        'qwen3.5:9b'
      );

      assert.strictEqual(decision.model, 'qwen3.5:9b');
      assert.ok(decision.reason.includes('preserving user-selected model "qwen3.5:9b"'), `Expected reason to mention preserving pinned model, got: ${decision.reason}`);
    });
  });
});
