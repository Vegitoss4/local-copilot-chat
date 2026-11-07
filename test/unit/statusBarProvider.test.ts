import * as assert from 'assert';
import * as vscode from 'vscode';
import { StatusBarProvider } from '../../src/providers/statusBarProvider';
import { SessionEngine } from '../../src/services/sessionEngine';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 11.8: Status Bar & Accessibility Provider Suite', () => {
  let sessionEngine: SessionEngine;
  let statusBarProvider: StatusBarProvider;
  const tempDir = 'C:\\Projects\\test-workspace';

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'status-workspace', uri: MockUri.file(tempDir), index: 0 }
    ]);
    SessionEngine.resetInstance();
    StatusBarProvider.resetInstance();

    const mockOllama = {
      streamChat: async () => 'test response'
    };

    sessionEngine = new SessionEngine(mockOllama as unknown as OllamaService);
    statusBarProvider = new StatusBarProvider(sessionEngine);
  });

  afterEach(() => {
    statusBarProvider.dispose();
    StatusBarProvider.resetInstance();
    SessionEngine.resetInstance();
  });

  describe('Status Bar Text & Visual Warning Thresholds', () => {
    it('should format status bar item with model, mode, and context percentage', () => {
      statusBarProvider.updateMetrics({
        model: 'qwen2.5-coder:7b',
        mode: 'chat',
        usedTokens: 2048,
        maxTokens: 8192,
        isGenerating: false
      });

      const item = statusBarProvider.getStatusBarItem();
      assert.ok(item.text.includes('$(sparkle)'));
      assert.ok(item.text.includes('Copilot: qwen2.5-coder'));
      assert.ok(item.text.includes('[CHAT]'));
      assert.ok(item.text.includes('25%'));
    });

    it('should set warning color background when context utilization exceeds 80%', () => {
      statusBarProvider.updateMetrics({
        usedTokens: 7000,
        maxTokens: 8192 // ~85%
      });

      const item = statusBarProvider.getStatusBarItem();
      assert.ok(item.text.includes('85%'));
      assert.ok(item.backgroundColor);
      assert.strictEqual((item.backgroundColor as any).id, 'statusBarItem.warningBackground');
    });

    it('should set error color background when context utilization exceeds 90%', () => {
      statusBarProvider.updateMetrics({
        usedTokens: 7800,
        maxTokens: 8192 // ~95%
      });

      const item = statusBarProvider.getStatusBarItem();
      assert.ok(item.text.includes('95%'));
      assert.ok(item.backgroundColor);
      assert.strictEqual((item.backgroundColor as any).id, 'statusBarItem.errorBackground');
    });

    it('should clear background color when context utilization drops to <= 80%', () => {
      statusBarProvider.updateMetrics({
        usedTokens: 3000,
        maxTokens: 8192 // ~37%
      });

      const item = statusBarProvider.getStatusBarItem();
      assert.strictEqual(item.backgroundColor, undefined);
    });
  });

  describe('Engine Stream Event Updates & Tooltip', () => {
    it('should display spinning sync icon while generation is active', () => {
      statusBarProvider.updateMetrics({ isGenerating: true });
      const item = statusBarProvider.getStatusBarItem();
      assert.ok(item.text.includes('$(sync~spin)'));

      statusBarProvider.updateMetrics({ isGenerating: false });
      assert.ok(item.text.includes('$(sparkle)'));
    });

    it('should format informative accessible tooltip', () => {
      statusBarProvider.updateMetrics({
        model: 'deepseek-r1:8b',
        mode: 'plan',
        usedTokens: 4096,
        maxTokens: 8192
      });

      const item = statusBarProvider.getStatusBarItem();
      assert.ok(item.tooltip);
      const tooltipStr = (item.tooltip as vscode.MarkdownString).value;

      assert.ok(tooltipStr.includes('deepseek-r1:8b'));
      assert.ok(tooltipStr.includes('PLAN'));
      assert.ok(tooltipStr.includes('4096 / 8192 tokens (50%)'));
    });
  });
});
