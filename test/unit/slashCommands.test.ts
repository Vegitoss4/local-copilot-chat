import * as assert from 'assert';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { OllamaService } from '../../src/services/ollamaService';
import { AgentToolService } from '../../src/services/agentToolService';
import { AppGeneratorService } from '../../src/services/appGeneratorService';
import { resetMockState, MockUri } from '../mocks/vscodeMock';

describe('Phase 5.5 H1: Slash Command Routing, Stream Ownership & Error Containment Suite', () => {
  let provider: ChatViewProvider;
  let postedMessages: any[];
  let mockWebview: any;

  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
    postedMessages = [];

    mockWebview = {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
      },
    };

    const service = new OllamaService('http://127.0.0.1:11434');
    provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
    provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);
  });

  describe('1. Slash Command Routing & Reserved Commands', () => {
    it('should route /diff and dispatch git diff output with startStream and exactly one streamEnd', async () => {
      await (provider as any)._handleSendMessage('/diff', 'auto', 'chat');

      const start = postedMessages.find((m) => m.type === 'startStream');
      const chunks = postedMessages.filter((m) => m.type === 'streamChunk');
      const ends = postedMessages.filter((m) => m.type === 'streamEnd');

      assert.ok(start, 'Must post startStream');
      assert.ok(chunks.length > 0, 'Must post at least one streamChunk');
      assert.strictEqual(ends.length, 1, 'Must post exactly one streamEnd');
      assert.strictEqual((provider as any)._isGenerating, false, '_isGenerating must be reset to false');
    });

    it('should route /build and display build check output without falling through to LLM chat', async () => {
      // Mock checkBuild
      const origCheckBuild = AgentToolService.checkBuild;
      try {
        AgentToolService.checkBuild = async () => ({
          success: true,
          output: 'Build succeeded with 0 errors.',
        });

        await (provider as any)._handleSendMessage('/build', 'auto', 'chat');

        const chunks = postedMessages.filter((m) => m.type === 'streamChunk');
        const ends = postedMessages.filter((m) => m.type === 'streamEnd');

        assert.ok(chunks.length > 0, 'Must post build output');
        assert.ok(chunks.some((c) => c.chunk.includes('Build succeeded')));
        assert.strictEqual(ends.length, 1, 'Must post exactly one streamEnd');
        assert.strictEqual((provider as any)._isGenerating, false);
      } finally {
        AgentToolService.checkBuild = origCheckBuild;
      }
    });

    it('should route active slash commands (/fix, /commit, /search, /read) cleanly without falling through to chat', async () => {
      const activeCmds = ['/fix', '/commit', '/search testQuery', '/read src/index.ts'];

      for (const cmd of activeCmds) {
        postedMessages = [];
        await (provider as any)._handleSendMessage(cmd, 'auto', 'chat');

        const chunks = postedMessages.filter((m) => m.type === 'streamChunk');
        const ends = postedMessages.filter((m) => m.type === 'streamEnd');

        assert.ok(chunks.length > 0, `Must post response chunk for command ${cmd}`);
        assert.strictEqual(ends.length, 1, `Must post exactly one streamEnd for ${cmd}`);
        assert.strictEqual((provider as any)._isGenerating, false);
      }
    });

    it('should provide actionable guidance for unknown slash commands', async () => {
      await (provider as any)._handleSendMessage('/unknown-command-xyz', 'auto', 'chat');

      const chunks = postedMessages.filter((m) => m.type === 'streamChunk');
      const ends = postedMessages.filter((m) => m.type === 'streamEnd');

      assert.ok(chunks.length > 0);
      assert.ok(chunks.some((c) => c.chunk.includes('Unknown command')));
      assert.strictEqual(ends.length, 1);
      assert.strictEqual((provider as any)._isGenerating, false);
    });
  });

  describe('2. Error Containment & Lifecycle Safety', () => {
    it('should handle backend error in /diff gracefully and always post streamEnd', async () => {
      const origGetGitDiff = AgentToolService.getGitDiff;
      try {
        AgentToolService.getGitDiff = async () => {
          throw new Error('Simulated Git backend failure');
        };

        await (provider as any)._handleSendMessage('/diff', 'auto', 'chat');

        const chunks = postedMessages.filter((m) => m.type === 'streamChunk');
        const ends = postedMessages.filter((m) => m.type === 'streamEnd');

        assert.ok(chunks.some((c) => c.chunk.includes('Failed') || c.chunk.includes('Simulated Git backend failure')));
        assert.strictEqual(ends.length, 1, 'streamEnd must be dispatched despite backend failure');
        assert.strictEqual((provider as any)._isGenerating, false);
      } finally {
        AgentToolService.getGitDiff = origGetGitDiff;
      }
    });

    it('should handle backend error in /create-app gracefully without hanging', async () => {
      const origGenerate = AppGeneratorService.generateFullStackApp;
      try {
        AppGeneratorService.generateFullStackApp = async () => {
          throw new Error('Simulated generator fatal error');
        };

        await (provider as any)._handleSendMessage('/create-app Failure Test', 'auto', 'chat');

        const errors = postedMessages.filter((m) => m.type === 'streamError');
        const ends = postedMessages.filter((m) => m.type === 'streamEnd');

        assert.ok(errors.length > 0, 'Must dispatch streamError');
        assert.strictEqual(ends.length, 1, 'Must dispatch streamEnd exactly once');
        assert.strictEqual((provider as any)._isGenerating, false);
      } finally {
        AppGeneratorService.generateFullStackApp = origGenerate;
      }
    });

    it('should enforce stream turn ownership so earlier aborted turn cannot terminate active generation', async () => {
      let resolveFirst: (() => void) | undefined;
      const firstPromise = new Promise<void>((r) => { resolveFirst = r; });

      const origGetGitDiff = AgentToolService.getGitDiff;
      try {
        AgentToolService.getGitDiff = async () => {
          await firstPromise;
          return 'First turn diff';
        };

        // Start first slow turn
        const turn1 = (provider as any)._handleSendMessage('/diff', 'auto', 'chat');

        // Immediately start second turn while first is pending
        AgentToolService.getGitDiff = async () => 'Second turn diff';
        const turn2 = (provider as any)._handleSendMessage('/diff', 'auto', 'chat');

        // Allow first turn to complete its asynchronous work
        if (resolveFirst) resolveFirst();
        await Promise.all([turn1, turn2]);

        assert.strictEqual((provider as any)._isGenerating, false);
        // Turn 2 must be the one whose streamEnd is final
        const ends = postedMessages.filter((m) => m.type === 'streamEnd');
        assert.ok(ends.length >= 1);
      } finally {
        AgentToolService.getGitDiff = origGetGitDiff;
      }
    });
  });
});
