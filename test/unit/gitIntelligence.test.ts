import * as assert from 'assert';
import {
  GitIntelligenceService,
  GitWorkingTreeStatus,
  StructuredDiff
} from '../../src/services/gitIntelligenceService';
import { OllamaService } from '../../src/services/ollamaService';

describe('Deliverable 11.7: Git-Aware Development Suite', () => {
  let service: GitIntelligenceService;
  let mockOllamaService: any;

  beforeEach(() => {
    service = GitIntelligenceService.getInstance();
    mockOllamaService = {
      streamChat: async (
        model: string,
        messages: any[],
        onChunk: (chunk: string) => void
      ) => {
        const prompt = messages[messages.length - 1].content;
        if (prompt.includes('Conventional Commit')) {
          return 'feat(auth): add OAuth2 token refresh support\n\nImplements auto-refresh mechanism for expired tokens.';
        }
        return '### Summary\nUpgrades authentication module with token refresh.';
      }
    };
  });

  describe('Git Status Parser', () => {
    it('should parse git status --short output with staged, unstaged, and untracked files', () => {
      const sampleStatus =
        '## main...origin/main [ahead 1]\n' +
        'M  package.json\n' +
        ' M src/index.ts\n' +
        'A  src/services/newService.ts\n' +
        'D  legacyFile.ts\n' +
        '?? test/scratch.ts\n';

      const status: GitWorkingTreeStatus = GitIntelligenceService.parseStatusOutput(sampleStatus);

      assert.strictEqual(status.isClean, false);
      assert.strictEqual(status.branch, 'main');
      assert.strictEqual(status.stagedCount, 3); // package.json, newService.ts, legacyFile.ts
      assert.strictEqual(status.unstagedCount, 1); // src/index.ts
      assert.strictEqual(status.untrackedCount, 1); // test/scratch.ts
    });

    it('should report clean status when output contains no file lines', () => {
      const cleanOutput = '## feature/login...origin/feature/login\n';
      const status = GitIntelligenceService.parseStatusOutput(cleanOutput);

      assert.strictEqual(status.isClean, true);
      assert.strictEqual(status.branch, 'feature/login');
      assert.strictEqual(status.files.length, 0);
    });
  });

  describe('Structured Diff Parser', () => {
    it('should parse git diff --numstat into additions, deletions, and binary files', () => {
      const sampleNumstat =
        '25\t10\tsrc/services/auth.ts\n' +
        '40\t0\tsrc/services/token.ts\n' +
        '-\t-\tassets/logo.png\n';

      const diff: StructuredDiff = GitIntelligenceService.parseNumstatOutput('sample diff text', sampleNumstat);

      assert.strictEqual(diff.rawDiff, 'sample diff text');
      assert.strictEqual(diff.files.length, 3);
      assert.strictEqual(diff.totalAdditions, 65);
      assert.strictEqual(diff.totalDeletions, 10);

      const authFile = diff.files.find(f => f.filePath === 'src/services/auth.ts');
      assert.ok(authFile);
      assert.strictEqual(authFile.additions, 25);
      assert.strictEqual(authFile.deletions, 10);
      assert.strictEqual(authFile.isBinary, false);

      const logoFile = diff.files.find(f => f.filePath === 'assets/logo.png');
      assert.ok(logoFile);
      assert.strictEqual(logoFile.isBinary, true);
    });
  });

  describe('Conventional Commit & PR Description Generation', () => {
    it('should generate conventional commit proposal from structured diff', async () => {
      const diff: StructuredDiff = {
        rawDiff: 'diff --git a/src/auth.ts b/src/auth.ts...',
        files: [{ filePath: 'src/auth.ts', additions: 15, deletions: 5, isBinary: false }],
        totalAdditions: 15,
        totalDeletions: 5
      };

      const commit = await service.generateConventionalCommit(
        diff,
        mockOllamaService as unknown as OllamaService,
        'qwen2.5-coder:7b'
      );

      assert.ok(commit.startsWith('feat(auth): add OAuth2 token refresh support'));
    });

    it('should generate comprehensive GitHub PR description with file matrix', async () => {
      const diff: StructuredDiff = {
        rawDiff: 'diff --git a/src/auth.ts b/src/auth.ts...',
        files: [
          { filePath: 'src/auth.ts', additions: 20, deletions: 5, isBinary: false },
          { filePath: 'src/token.ts', additions: 30, deletions: 2, isBinary: false }
        ],
        totalAdditions: 50,
        totalDeletions: 7
      };

      const pr = await service.generatePrDescription(
        diff,
        mockOllamaService as unknown as OllamaService,
        'qwen2.5-coder:7b',
        'Add Token Refresh Feature'
      );

      assert.ok(pr.includes('## Add Token Refresh Feature'));
      assert.ok(pr.includes('### Summary'));
      assert.ok(pr.includes('### File Change Matrix'));
      assert.ok(pr.includes('`src/auth.ts`'));
      assert.ok(pr.includes('+50 / -7'));
    });
  });
});
