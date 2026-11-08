import * as assert from 'assert';
import { ContextOptimizationService } from '../../src/services/contextOptimizationService';
import { ChatMessage } from '../../src/services/ollamaService';

describe('Deliverable 12.3: Context-Window Optimization & Prefix Caching Suite', () => {
  describe('CPU Offload Detection', () => {
    it('should detect partial CPU offloading and construct informative warning message', async () => {
      const mockOllama: any = {
        getLoadedModels: async () => [
          {
            name: 'deepseek-r1:14b',
            model: 'deepseek-r1:14b',
            size: 9.0 * 1024 * 1024 * 1024,
            sizeVram: 5.5 * 1024 * 1024 * 1024
          }
        ]
      };

      const status = await ContextOptimizationService.checkCpuOffload(mockOllama);
      assert.ok(status !== null);
      assert.strictEqual(status!.isOffloaded, true);
      assert.strictEqual(status!.modelTag, 'deepseek-r1:14b');
      assert.strictEqual(status!.gpuOffloadRatio, 0.61);
      assert.ok(status!.warningMessage?.includes('partially offloaded to CPU'));
    });

    it('should report 100% GPU residency when size equals size_vram', async () => {
      const mockOllama: any = {
        getLoadedModels: async () => [
          {
            name: 'qwen2.5-coder:7b',
            model: 'qwen2.5-coder:7b',
            size: 4.8 * 1024 * 1024 * 1024,
            sizeVram: 4.8 * 1024 * 1024 * 1024
          }
        ]
      };

      const status = await ContextOptimizationService.checkCpuOffload(mockOllama);
      assert.ok(status !== null);
      assert.strictEqual(status!.isOffloaded, false);
      assert.strictEqual(status!.gpuOffloadRatio, 1.0);
      assert.strictEqual(status!.warningMessage, undefined);
    });
  });

  describe('Prefix Cache Prompt Stability', () => {
    it('should confirm prefix cache stability when system prompt and tool headers are identical', () => {
      const prevMessages: ChatMessage[] = [
        { role: 'system', content: 'You are an autonomous engineering agent with access to readFile, writeFile.' },
        { role: 'user', content: 'What is in src/index.ts?' },
        { role: 'assistant', content: 'Inspecting workspace file...' }
      ];

      const currMessages: ChatMessage[] = [
        { role: 'system', content: 'You are an autonomous engineering agent with access to readFile, writeFile.' },
        { role: 'user', content: 'What is in src/index.ts?' },
        { role: 'assistant', content: 'Inspecting workspace file...' },
        { role: 'user', content: 'Now please check the build.' }
      ];

      const result = ContextOptimizationService.verifyPrefixCacheStability(prevMessages, currMessages);
      assert.strictEqual(result.isStable, true);
      assert.ok(result.prefixLengthChars > 50);
    });

    it('should detect prompt divergence when system prompt is mutated across turns', () => {
      const prevMessages: ChatMessage[] = [
        { role: 'system', content: 'System prompt version 1: Standard agent' },
        { role: 'user', content: 'Hello' }
      ];

      const currMessages: ChatMessage[] = [
        { role: 'system', content: 'System prompt version 2: Mutated instructions' },
        { role: 'user', content: 'Hello' }
      ];

      const result = ContextOptimizationService.verifyPrefixCacheStability(prevMessages, currMessages);
      assert.strictEqual(result.isStable, false);
      assert.strictEqual(result.divergenceIndex, 0);
      assert.ok(result.divergenceReason?.includes('System prompt mutated'));
    });
  });

  describe('Context Size Recommendation', () => {
    it('should recommend 8192 tokens for standard 4.8 GB 7B model in 8 GB VRAM budget', () => {
      const recommended = ContextOptimizationService.recommendContextSize(
        4.8 * 1024 * 1024 * 1024,
        8 * 1024 * 1024 * 1024
      );
      assert.ok(recommended >= 4096 && recommended <= 16384);
    });
  });
});
