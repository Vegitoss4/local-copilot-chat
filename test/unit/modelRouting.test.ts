import * as assert from 'assert';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { OllamaService } from '../../src/services/ollamaService';
import { vscodeMock } from '../mocks/vscodeMock';

describe('Model Routing & Auto-Selection Baseline', () => {
  const ollamaService = new OllamaService('http://127.0.0.1:11434');
  const availableModels = ['deepseek-r1:8b', 'qwen2.5-coder:7b', 'qwen3.5:9b'];

  it('should route reasoning and diagnostic keywords to DeepSeek-R1 in chat mode', () => {
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

  it('should route syntax and coding requests to Qwen 2.5 Coder in chat mode', () => {
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

  it('should unconditionally route to reasoning model in agent mode', () => {
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
        'deepseek-r1:8b',
        `Expected agent mode prompt "${prompt}" to route to deepseek-r1:8b`
      );
    }
  });

  it('should correctly select persona model via resolveModelForRole', () => {
    const orchModel = ollamaService.resolveModelForRole('orchestrator', 'auto', availableModels);
    assert.strictEqual(orchModel, 'deepseek-r1:8b');

    const plannerModel = ollamaService.resolveModelForRole('planner', 'auto', availableModels);
    assert.strictEqual(plannerModel, 'deepseek-r1:8b');

    const coderModel = ollamaService.resolveModelForRole('coder', 'auto', availableModels);
    assert.strictEqual(coderModel, 'qwen2.5-coder:7b');

    const testerModel = ollamaService.resolveModelForRole('tester', 'auto', availableModels);
    assert.strictEqual(testerModel, 'qwen2.5-coder:7b');
  });

  it('should correctly select execution model via resolveModelForPhase', () => {
    // When deepseek-r1 is selected, planning stays deepseek, execution transitions to coder
    const planModel = ollamaService.resolveModelForPhase('planning', 'deepseek-r1:8b', availableModels);
    assert.strictEqual(planModel, 'deepseek-r1:8b');

    const execModel = ollamaService.resolveModelForPhase('execution', 'deepseek-r1:8b', availableModels);
    assert.ok(execModel.includes('qwen'), `Expected execution phase to route to Qwen, got ${execModel}`);
  });
});
