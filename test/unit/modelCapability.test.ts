import * as assert from 'assert';
import { OllamaService } from '../../src/services/ollamaService';

describe('Deliverable 2 & C: Model Capability Inspection Suite', () => {
  it('should inspect capabilities from /api/show without hardcoded model names', async () => {
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string, init?: any) => {
        if (url.endsWith('/api/show')) {
          const body = JSON.parse(init?.body || '{}');
          if (body.model === 'test-coder-model') {
            return {
              ok: true,
              json: async () => ({
                capabilities: ['completion', 'tools', 'insert'],
                template: '{{ .Tools }}',
              }),
            } as any;
          }
          if (body.model === 'test-text-model') {
            return {
              ok: true,
              json: async () => ({
                capabilities: ['completion'],
                template: '{{ .Prompt }}',
              }),
            } as any;
          }
        }
        return { ok: false, status: 404 } as any;
      };

      const service = new OllamaService();

      const coderCaps = await service.getModelCapabilities('test-coder-model');
      assert.strictEqual(coderCaps.hasTools, true);
      assert.strictEqual(coderCaps.status, 'supported');
      assert.deepStrictEqual(coderCaps.capabilities, ['completion', 'tools', 'insert']);

      const textCaps = await service.getModelCapabilities('test-text-model');
      assert.strictEqual(textCaps.hasTools, false);
      assert.strictEqual(textCaps.status, 'unsupported');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('should cache capabilities and invalidate on clearCapabilityCache()', async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string) => {
        if (url.endsWith('/api/show')) {
          callCount++;
          return {
            ok: true,
            json: async () => ({ capabilities: ['tools'] }),
          } as any;
        }
        return { ok: false } as any;
      };

      const service = new OllamaService();
      await service.getModelCapabilities('cached-model');
      await service.getModelCapabilities('cached-model');
      assert.strictEqual(callCount, 1);

      service.clearCapabilityCache();
      await service.getModelCapabilities('cached-model');
      assert.strictEqual(callCount, 2);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('should filter models declaring tools from /api/tags', async () => {
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string) => {
        if (url.endsWith('/api/tags')) {
          return {
            ok: true,
            json: async () => ({
              models: [
                { name: 'model-a', capabilities: ['completion'] },
                { name: 'model-b', capabilities: ['completion', 'tools'] },
                { name: 'model-c', capabilities: ['tools', 'thinking'] },
              ],
            }),
          } as any;
        }
        return { ok: false } as any;
      };

      const service = new OllamaService();
      const withTools = await service.getModelsWithTools();
      assert.deepStrictEqual(withTools, ['model-b', 'model-c']);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('should return status "unknown" when /api/show fails or lacks capabilities', async () => {
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async () => ({
        ok: false,
        status: 500,
      } as any);

      const service = new OllamaService();
      const caps = await service.getModelCapabilities('unknown-model');
      assert.strictEqual(caps.status, 'unknown');
      assert.strictEqual(caps.hasTools, false);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});
