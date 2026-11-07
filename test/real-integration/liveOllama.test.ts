import * as assert from 'assert';
import { OllamaService } from '../../src/services/ollamaService';
import { ModelLifecycleManager } from '../../src/services/modelLifecycleManager';
import { ConfigurationService } from '../../src/services/configurationService';
import { nativeFetch } from '../setup';

describe('Phase 8.2: Real-World Live Ollama Daemon & VRAM Verification Tier', function () {
  this.timeout(45000); // Allow time for real GPU model loading on 8 GB VRAM

  let originalFetch: any;
  let isLiveOllamaAvailable = false;
  const endpoint = 'http://127.0.0.1:11434';

  before(async function () {
    originalFetch = global.fetch;
    if (nativeFetch) {
      global.fetch = nativeFetch;
    }

    try {
      const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        isLiveOllamaAvailable = true;
      }
    } catch {
      isLiveOllamaAvailable = false;
    }

    if (!isLiveOllamaAvailable) {
      console.log('Live Ollama daemon not accessible on 127.0.0.1:11434. Skipping live tests.');
    }
  });

  after(async function () {
    global.fetch = originalFetch;
    // Always clean up any resident model loaded during live testing
    if (isLiveOllamaAvailable) {
      try {
        const ollama = new OllamaService(endpoint);
        const loaded = await ollama.getLoadedModels();
        for (const m of loaded) {
          await ollama.unloadModel(m.name || m.model);
        }
      } catch {}
    }
  });

  beforeEach(function () {
    if (!isLiveOllamaAvailable) {
      this.skip();
    }
  });

  it('should discover installed local models from live Ollama daemon', async () => {
    const service = new OllamaService(endpoint);
    const models = await service.getAvailableModels();

    assert.ok(Array.isArray(models) && models.length > 0, 'No models returned from live Ollama');
    assert.ok(
      models.some((m) => m.includes('qwen') || m.includes('deepseek')),
      `Expected qwen or deepseek models, got: ${JSON.stringify(models)}`
    );
  });

  it('should stream tokens from real qwen2.5-coder:7b and verify VRAM residency via /api/ps', async () => {
    const service = new OllamaService(endpoint);
    const available = await service.getAvailableModels();
    const modelToTest = available.find((m) => m.includes('qwen2.5-coder:7b')) || available[0];

    let fullOutput = '';
    const output = await service.streamChat(
      modelToTest,
      [{ role: 'user', content: 'Output the exact word "COPILOT_OK" and nothing else.' }],
      (chunk) => {
        fullOutput += chunk;
      },
      undefined,
      { num_ctx: 2048, temperature: 0.1 },
      { headersTimeoutMs: 30000, idleStreamTimeoutMs: 15000 }
    );

    assert.ok(output.length > 0, 'Model produced empty stream');
    assert.ok(fullOutput.length > 0, 'Callback received no chunks');

    // Inspect live VRAM residency via GET /api/ps
    const residentModels = await service.getLoadedModels();
    assert.ok(residentModels.length > 0, 'Expected model to be resident in GPU VRAM after generation');
    assert.ok(
      residentModels.some((m) => m.name.includes(modelToTest) || m.model.includes(modelToTest)),
      `Model ${modelToTest} was not found in loaded models: ${JSON.stringify(residentModels)}`
    );
  });

  it('should cleanly unload resident model releasing VRAM under 8 GB constraints', async () => {
    const service = new OllamaService(endpoint);
    const residentBefore = await service.getLoadedModels();

    for (const m of residentBefore) {
      const unloaded = await service.unloadModel(m.name || m.model);
      assert.strictEqual(unloaded, true, `Failed to unload ${m.name}`);
    }

    // Verify /api/ps reports VRAM is released
    const residentAfter = await service.getLoadedModels();
    assert.strictEqual(
      residentAfter.length,
      0,
      `VRAM was not freed after unloadModel; remaining: ${JSON.stringify(residentAfter)}`
    );
  });
});
