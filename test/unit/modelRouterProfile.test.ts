import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ModelRouter, ModelProfile } from '../../src/services/modelRouter';
import { resetMockState, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Deliverable 12.4: Deterministic ModelRouter & Profile Schema Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { uri: vscode.Uri.file(tempDir), name: 'test-ws', index: 0 }
    ]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Swap-Cost Aware Routing Policy', () => {
    it('should stay on resident model when router is disabled (default)', () => {
      const decision = ModelRouter.evaluateRouteWithProfiles({
        prompt: 'Why does this algorithm fail?',
        currentResidentModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b', 'deepseek-r1:8b'],
        isRouterEnabled: false
      });

      assert.strictEqual(decision.model, 'qwen2.5-coder:7b');
      assert.strictEqual(decision.isSwapRecommended, false);
      assert.ok(decision.reason.includes('ModelRouter is disabled'));
    });

    it('should recommend model swap when capability gain exceeds 15% threshold', () => {
      const profiles = new Map<string, ModelProfile>();
      profiles.set('qwen2.5-coder:7b', {
        modelTag: 'qwen2.5-coder:7b',
        measuredTps: 35.0,
        vramBytes: 4.8 * 1024 * 1024 * 1024,
        effectiveContextTokens: 8192,
        toolCallReliability: 0.95,
        categoryStrengths: { reasoning: 65, code_repair: 90 },
        swapCostMs: 4000
      });
      profiles.set('deepseek-r1:8b', {
        modelTag: 'deepseek-r1:8b',
        measuredTps: 28.0,
        vramBytes: 4.9 * 1024 * 1024 * 1024,
        effectiveContextTokens: 8192,
        toolCallReliability: 0.85,
        categoryStrengths: { reasoning: 92, code_repair: 70 },
        swapCostMs: 4500
      });

      const decision = ModelRouter.evaluateRouteWithProfiles({
        prompt: 'Please explain the architectural difference and analyze root cause',
        currentResidentModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b', 'deepseek-r1:8b'],
        profiles,
        isRouterEnabled: true,
        swapThresholdPercent: 15
      });

      // 92 - 65 = +27% delta >= 15% threshold -> Swap justified!
      assert.strictEqual(decision.model, 'deepseek-r1:8b');
      assert.strictEqual(decision.isSwapRecommended, true);
      assert.strictEqual(decision.swapCostMs, 4500);
      assert.ok(decision.reason.includes('Swap justified'));
    });

    it('should reject model swap when capability gain is below 15% threshold', () => {
      const profiles = new Map<string, ModelProfile>();
      profiles.set('qwen2.5-coder:7b', {
        modelTag: 'qwen2.5-coder:7b',
        measuredTps: 35.0,
        vramBytes: 4.8 * 1024 * 1024 * 1024,
        effectiveContextTokens: 8192,
        toolCallReliability: 0.95,
        categoryStrengths: { reasoning: 80, code_repair: 90 },
        swapCostMs: 4000
      });
      profiles.set('deepseek-r1:8b', {
        modelTag: 'deepseek-r1:8b',
        measuredTps: 28.0,
        vramBytes: 4.9 * 1024 * 1024 * 1024,
        effectiveContextTokens: 8192,
        toolCallReliability: 0.85,
        categoryStrengths: { reasoning: 85, code_repair: 70 },
        swapCostMs: 4500
      });

      const decision = ModelRouter.evaluateRouteWithProfiles({
        prompt: 'Explain this design',
        currentResidentModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b', 'deepseek-r1:8b'],
        profiles,
        isRouterEnabled: true,
        swapThresholdPercent: 15
      });

      // 85 - 80 = +5% delta < 15% threshold -> Do not swap!
      assert.strictEqual(decision.model, 'qwen2.5-coder:7b');
      assert.strictEqual(decision.isSwapRecommended, false);
      assert.ok(decision.reason.includes('Swap cost (4500ms) not justified'));
    });
  });

  describe('Profile Storage & Persistence', () => {
    it('should save and reload ModelProfile atomically from workspace disk', async () => {
      const profile: ModelProfile = {
        modelTag: 'test-model:7b',
        measuredTps: 32.5,
        vramBytes: 4.5 * 1024 * 1024 * 1024,
        effectiveContextTokens: 8192,
        toolCallReliability: 0.92,
        categoryStrengths: { code_repair: 88, feature_gen: 84 },
        swapCostMs: 3800
      };

      const savedPath = await ModelRouter.saveProfile(profile, tempDir);
      assert.ok(savedPath.includes('test-model_7b.json'));

      const loaded = await ModelRouter.loadProfile('test-model:7b', tempDir);
      assert.ok(loaded !== null);
      assert.strictEqual(loaded!.modelTag, 'test-model:7b');
      assert.strictEqual(loaded!.measuredTps, 32.5);
      assert.strictEqual(loaded!.toolCallReliability, 0.92);
    });
  });
});
