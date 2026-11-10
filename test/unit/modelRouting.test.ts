import * as assert from 'assert';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { OllamaService } from '../../src/services/ollamaService';
import { vscodeMock } from '../mocks/vscodeMock';

describe('Model Routing & Auto-Selection Baseline', () => {
  const ollamaService = new OllamaService('http://127.0.0.1:11434');
  const availableModels = ['deepseek-r1:8b', 'qwen2.5-coder:7b', 'qwen3.5:9b'];

  beforeEach(() => {
    (ollamaService as any)._capabilityCache.set('deepseek-r1:8b', {
      result: { model: 'deepseek-r1:8b', hasTools: false, capabilities: ['thinking', 'completion'], status: 'supported' },
      timestamp: Date.now()
    });
    (ollamaService as any)._capabilityCache.set('qwen2.5-coder:7b', {
      result: { model: 'qwen2.5-coder:7b', hasTools: true, capabilities: ['tools', 'insert', 'completion'], status: 'supported' },
      timestamp: Date.now()
    });
    (ollamaService as any)._capabilityCache.set('qwen3.5:9b', {
      result: { model: 'qwen3.5:9b', hasTools: true, capabilities: ['thinking', 'tools', 'completion', 'vision'], status: 'supported' },
      timestamp: Date.now()
    });
  });

  it('should route reasoning and diagnostic keywords based on thinking capability in chat mode', () => {
    const provider = new ChatViewProvider(vscodeMock.Uri.file('C:/extension'), ollamaService);
    // Inject cached models
    (provider as any)._cachedModels = availableModels;

    const reasoningPrompts = [
      'Why is this method throwing a NullReferenceException?',
      'Please explain how this dependency injection works',
      'Debug this concurrency deadlock in the queue worker',
      'Diagnose the high memory consumption in the server',
      'What architecture should I choose for multi-tenant auth?',
      'Plan the database schema migration',
      'Analyze the performance bottlenecks in this loop'
    ];

    for (const prompt of reasoningPrompts) {
      const selected = provider.resolveAutoModel(prompt, 'chat');
      assert.strictEqual(
        selected,
        'deepseek-r1:8b',
        `Expected prompt "${prompt}" to route to deepseek-r1:8b, got ${selected}`
      );
    }
  });

  it('should route syntax and coding requests based on tools and insert capability in chat mode', () => {
    const provider = new ChatViewProvider(vscodeMock.Uri.file('C:/extension'), ollamaService);
    (provider as any)._cachedModels = availableModels;

    const codingPrompts = [
      'Create a C# model for TaskItem with Id and Title',
      'Write an Angular service with Signals for loading products',
      'Generate a Dockerfile for ASP.NET 10 Web API',
      'Add a new button component with CSS styles'
    ];

    for (const prompt of codingPrompts) {
      const selected = provider.resolveAutoModel(prompt, 'chat');
      assert.strictEqual(
        selected,
        'qwen2.5-coder:7b',
        `Expected prompt "${prompt}" to route to qwen2.5-coder:7b, got ${selected}`
      );
    }
  });

  it('should route to tool-capable model in agent mode', () => {
    const provider = new ChatViewProvider(vscodeMock.Uri.file('C:/extension'), ollamaService);
    (provider as any)._cachedModels = availableModels;

    const prompts = [
      'Build a CRUD application',
      'Fix typo in readme',
      'npm install express'
    ];

    for (const prompt of prompts) {
      const selected = provider.resolveAutoModel(prompt, 'agent');
      assert.strictEqual(
        selected,
        'qwen2.5-coder:7b',
        `Expected agent mode prompt "${prompt}" to route to verified tool-capable model`
      );
    }
  });

  it('should preserve pinned user model across all roles with source=pinned', () => {
    const pinnedModel = 'qwen3.5:9b';
    const roles: Array<'orchestrator' | 'planner' | 'coder' | 'tester' | 'reviewer'> = [
      'orchestrator',
      'planner',
      'coder',
      'tester',
      'reviewer'
    ];

    for (const role of roles) {
      const res = ollamaService.resolveModelForRole(role, pinnedModel, availableModels);
      assert.strictEqual(res.model, pinnedModel, `Role "${role}" must use pinned model "${pinnedModel}"`);
      assert.strictEqual(res.source, 'pinned', `Role "${role}" source must be "pinned"`);
      assert.strictEqual(String(res), pinnedModel, `Coerced string must equal pinned model`);
    }
  });

  it('should resolve Auto mode via data-driven ModelRouter with source=router', () => {
    const mockRouter = {
      selectModel: (prompt: string, intent: string) => {
        return {
          model: intent === 'coding' ? 'qwen2.5-coder:7b' : 'qwen3.5:9b',
          rationale: 'data-driven selection'
        };
      }
    };

    const orchRes = ollamaService.resolveModelForRole('orchestrator', 'auto', availableModels, {
      modelRouter: mockRouter,
      prompt: 'Refactor system architecture'
    });
    assert.strictEqual(orchRes.model, 'qwen3.5:9b');
    assert.strictEqual(orchRes.source, 'router');

    const coderRes = ollamaService.resolveModelForRole('coder', 'auto', availableModels, {
      modelRouter: mockRouter,
      prompt: 'Write unit tests'
    });
    assert.strictEqual(coderRes.model, 'qwen2.5-coder:7b');
    assert.strictEqual(coderRes.source, 'router');
  });

  it('should honor explicit per-role setting with source=role-setting', () => {
    const roleSettings = {
      coder: 'qwen2.5-coder:7b',
      planner: 'deepseek-r1:8b'
    };

    // Even if user pinned a model, explicit roleSettings override it
    const coderRes = ollamaService.resolveModelForRole('coder', 'qwen3.5:9b', availableModels, {
      roleSettings
    });
    assert.strictEqual(coderRes.model, 'qwen2.5-coder:7b');
    assert.strictEqual(coderRes.source, 'role-setting');

    const plannerRes = ollamaService.resolveModelForRole('planner', 'qwen3.5:9b', availableModels, {
      roleSettings
    });
    assert.strictEqual(plannerRes.model, 'deepseek-r1:8b');
    assert.strictEqual(plannerRes.source, 'role-setting');

    // Unconfigured role (e.g. orchestrator) still uses pinned model
    const orchRes = ollamaService.resolveModelForRole('orchestrator', 'qwen3.5:9b', availableModels, {
      roleSettings
    });
    assert.strictEqual(orchRes.model, 'qwen3.5:9b');
    assert.strictEqual(orchRes.source, 'pinned');
  });

  it('should delegate resolveModelForPhase to resolveModelForRole without model regexes', () => {
    const pinned = 'qwen3.5:9b';
    const planRes = ollamaService.resolveModelForPhase('planning', pinned, availableModels);
    assert.strictEqual(planRes.model, pinned);
    assert.strictEqual(planRes.source, 'pinned');

    const execRes = ollamaService.resolveModelForPhase('execution', pinned, availableModels);
    assert.strictEqual(execRes.model, pinned);
    assert.strictEqual(execRes.source, 'pinned');
  });
});
