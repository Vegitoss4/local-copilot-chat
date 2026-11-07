import * as assert from 'assert';
import {
  CommandClassifier,
  CommandTier,
  CommandSyntaxError
} from '../../src/services/commandClassifier';

describe('CommandClassifier & Tokenization Security Suite', () => {
  describe('1. Tokenization and Metacharacter Rejection', () => {
    it('should correctly tokenize basic whitespace-separated commands', () => {
      const tokens = CommandClassifier.tokenizeCommandLine('git status --short');
      assert.deepStrictEqual(tokens, ['git', 'status', '--short']);
    });

    it('should preserve double-quoted strings with spaces', () => {
      const tokens = CommandClassifier.tokenizeCommandLine('git commit -m "feat: initial commit"');
      assert.deepStrictEqual(tokens, ['git', 'commit', '-m', 'feat: initial commit']);
    });

    it('should preserve single-quoted strings with spaces', () => {
      const tokens = CommandClassifier.tokenizeCommandLine("git commit -m 'feat: single quoted'");
      assert.deepStrictEqual(tokens, ['git', 'commit', '-m', 'feat: single quoted']);
    });

    it('should handle escaped quotes inside double quotes', () => {
      const tokens = CommandClassifier.tokenizeCommandLine('git commit -m "escaped \\"quotes\\""');
      assert.deepStrictEqual(tokens, ['git', 'commit', '-m', 'escaped "quotes"']);
    });

    it('should reject empty or whitespace-only commands', () => {
      assert.throws(() => CommandClassifier.tokenizeCommandLine(''), CommandSyntaxError);
      assert.throws(() => CommandClassifier.tokenizeCommandLine('   \t  '), CommandSyntaxError);
    });

    it('should reject unclosed quotes', () => {
      assert.throws(() => CommandClassifier.tokenizeCommandLine('git commit -m "unclosed'), CommandSyntaxError);
      assert.throws(() => CommandClassifier.tokenizeCommandLine("git commit -m 'unclosed"), CommandSyntaxError);
    });

    it('should strictly reject shell chaining operators (; & && ||)', () => {
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git status; rm -rf /'),
        /Shell syntax and metacharacters are rejected: found ';'/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git status && npm test'),
        /Shell syntax and metacharacters are rejected: found '&'/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('dotnet build || exit 1'),
        /Shell syntax and metacharacters are rejected: found '\|'/
      );
    });

    it('should strictly reject shell redirection operators (> < |)', () => {
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git diff > output.txt'),
        /Shell syntax and metacharacters are rejected: found '>'/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('cat < input.txt'),
        /Shell syntax and metacharacters are rejected: found '<'/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git log | head -n 10'),
        /Shell syntax and metacharacters are rejected: found '\|'/
      );
    });

    it('should strictly reject subshells ($() and backticks)', () => {
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git log $(whoami)'),
        /Shell syntax and metacharacters are rejected: found '\$'/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git log `whoami`'),
        /Shell syntax and metacharacters are rejected: found '`'/
      );
    });

    it('should strictly reject environment variable expansions (%VAR%)', () => {
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('echo %PATH%'),
        /Environment variable expansion \(%VAR%\) is not permitted/
      );
    });

    it('should strictly reject newlines, carriage returns, and null bytes', () => {
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git status\ncalc.exe'),
        /Shell syntax and metacharacters are rejected/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git status\rcalc.exe'),
        /Shell syntax and metacharacters are rejected/
      );
      assert.throws(
        () => CommandClassifier.tokenizeCommandLine('git status\0calc.exe'),
        /Shell syntax and metacharacters are rejected/
      );
    });
  });

  describe('2. Tier 1: Restricted Explicitly Permitted (Safe Read-Only)', () => {
    it('should classify safe git status commands as Tier 1', () => {
      const res1 = CommandClassifier.classify('git status');
      assert.strictEqual(res1.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res2 = CommandClassifier.classify('git status --short');
      assert.strictEqual(res2.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res3 = CommandClassifier.classify('git status -s -b');
      assert.strictEqual(res3.tier, CommandTier.TIER_1_SAFE_READONLY);
    });

    it('should classify safe git diff commands as Tier 1', () => {
      const res1 = CommandClassifier.classify('git diff');
      assert.strictEqual(res1.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res2 = CommandClassifier.classify('git diff --stat');
      assert.strictEqual(res2.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res3 = CommandClassifier.classify('git diff HEAD~1');
      assert.strictEqual(res3.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res4 = CommandClassifier.classify('git diff src/index.ts');
      assert.strictEqual(res4.tier, CommandTier.TIER_1_SAFE_READONLY);
    });

    it('should classify safe git log commands as Tier 1', () => {
      const res1 = CommandClassifier.classify('git log --oneline');
      assert.strictEqual(res1.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res2 = CommandClassifier.classify('git log -n 5');
      assert.strictEqual(res2.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res3 = CommandClassifier.classify('git log -n10 --stat');
      assert.strictEqual(res3.tier, CommandTier.TIER_1_SAFE_READONLY);
    });

    it('should classify safe git branch commands as Tier 1', () => {
      const res1 = CommandClassifier.classify('git branch');
      assert.strictEqual(res1.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res2 = CommandClassifier.classify('git branch -a');
      assert.strictEqual(res2.tier, CommandTier.TIER_1_SAFE_READONLY);

      const res3 = CommandClassifier.classify('git branch --show-current');
      assert.strictEqual(res3.tier, CommandTier.TIER_1_SAFE_READONLY);
    });

    it('should classify tool version inquiries as Tier 1', () => {
      const tools = ['git', 'node', 'npm', 'dotnet', 'tsc', 'python', 'cargo', 'go'];
      for (const tool of tools) {
        const res = CommandClassifier.classify(`${tool} --version`);
        assert.strictEqual(res.tier, CommandTier.TIER_1_SAFE_READONLY, `Expected ${tool} --version to be Tier 1`);
      }
    });
  });

  describe('3. Tier 2: Project Execution Commands (Approval Required)', () => {
    it('should classify npm test, start, run as Tier 2', () => {
      const res1 = CommandClassifier.classify('npm test');
      assert.strictEqual(res1.tier, CommandTier.TIER_2_PROJECT_EXECUTION);

      const res2 = CommandClassifier.classify('npm run build');
      assert.strictEqual(res2.tier, CommandTier.TIER_2_PROJECT_EXECUTION);

      const res3 = CommandClassifier.classify('npm run lint');
      assert.strictEqual(res3.tier, CommandTier.TIER_2_PROJECT_EXECUTION);
    });

    it('should classify dotnet build, test, run as Tier 2', () => {
      const res1 = CommandClassifier.classify('dotnet build');
      assert.strictEqual(res1.tier, CommandTier.TIER_2_PROJECT_EXECUTION);

      const res2 = CommandClassifier.classify('dotnet test');
      assert.strictEqual(res2.tier, CommandTier.TIER_2_PROJECT_EXECUTION);

      const res3 = CommandClassifier.classify('dotnet run');
      assert.strictEqual(res3.tier, CommandTier.TIER_2_PROJECT_EXECUTION);
    });

    it('should classify cargo build, test, check as Tier 2', () => {
      const res = CommandClassifier.classify('cargo test');
      assert.strictEqual(res.tier, CommandTier.TIER_2_PROJECT_EXECUTION);
    });

    it('should classify pytest and python test runners as Tier 2', () => {
      const res1 = CommandClassifier.classify('pytest');
      assert.strictEqual(res1.tier, CommandTier.TIER_2_PROJECT_EXECUTION);

      const res2 = CommandClassifier.classify('python -m unittest');
      assert.strictEqual(res2.tier, CommandTier.TIER_2_PROJECT_EXECUTION);
    });
  });

  describe('4. Tier 3: Arbitrary Commands & Package Execution (Approval Required Always)', () => {
    it('should classify npx and npm exec as Tier 3', () => {
      const res1 = CommandClassifier.classify('npx eslint .');
      assert.strictEqual(res1.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);

      const res2 = CommandClassifier.classify('npm exec prettier --write .');
      assert.strictEqual(res2.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);
    });

    it('should classify npm install and package mutations as Tier 3', () => {
      const res1 = CommandClassifier.classify('npm install lodash');
      assert.strictEqual(res1.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);

      const res2 = CommandClassifier.classify('npm uninstall express');
      assert.strictEqual(res2.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);
    });

    it('should classify dotnet package and tool commands as Tier 3', () => {
      const res = CommandClassifier.classify('dotnet add package Microsoft.EntityFrameworkCore');
      assert.strictEqual(res.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);
    });

    it('should classify mutating git commands as Tier 3', () => {
      const res1 = CommandClassifier.classify('git commit -m "fix: bug"');
      assert.strictEqual(res1.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);

      const res2 = CommandClassifier.classify('git checkout -b feature');
      assert.strictEqual(res2.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);
    });

    it('should demote git diff with unwhitelisted flags to Tier 3', () => {
      // --ext-diff is not an allowed Tier 1 flag
      const res = CommandClassifier.classify('git diff --ext-diff');
      assert.strictEqual(res.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);
    });

    it('should classify unknown custom CLI tools as Tier 3', () => {
      const res = CommandClassifier.classify('my-custom-cli --flag value');
      assert.strictEqual(res.tier, CommandTier.TIER_3_ARBITRARY_COMMAND);
    });
  });

  describe('5. Tier 4: Prohibited Operations (Fail Closed — Never Executable)', () => {
    it('should prohibit direct execution of .bat, .cmd, .ps1, and .vbs scripts', () => {
      const scripts = ['build.bat', 'setup.cmd', 'run.ps1', 'macro.vbs'];
      for (const script of scripts) {
        const res = CommandClassifier.classify(`./${script}`);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected ${script} to be classified as Tier 4 Prohibited`
        );
      }
    });

    it('should prohibit direct invocation of interactive shells', () => {
      const shells = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl'];
      for (const shell of shells) {
        const res = CommandClassifier.classify(`${shell} -c "echo 1"`);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected ${shell} to be classified as Tier 4 Prohibited`
        );
      }
    });

    it('should prohibit privilege escalation utilities', () => {
      const escalation = ['sudo', 'runas', 'su', 'doas'];
      for (const cmd of escalation) {
        const res = CommandClassifier.classify(`${cmd} whoami`);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected ${cmd} to be classified as Tier 4 Prohibited`
        );
      }
    });

    it('should prohibit network downloader / exfiltration utilities', () => {
      const downloaders = ['curl', 'wget', 'certutil', 'bitsadmin', 'nc'];
      for (const dl of downloaders) {
        const res = CommandClassifier.classify(`${dl} http://example.com`);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected ${dl} to be classified as Tier 4 Prohibited`
        );
      }
    });

    it('should prohibit destructive system utilities', () => {
      const destructive = ['format', 'diskpart', 'rmdir', 'del', 'rm', 'shutdown', 'reboot'];
      for (const tool of destructive) {
        const res = CommandClassifier.classify(`${tool} C:`);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected ${tool} to be classified as Tier 4 Prohibited`
        );
      }
    });

    it('should prohibit process management utilities', () => {
      const proc = ['kill', 'taskkill', 'pkill'];
      for (const p of proc) {
        const res = CommandClassifier.classify(`${p} 1234`);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected ${p} to be classified as Tier 4 Prohibited`
        );
      }
    });

    it('should prohibit dangerous Git configuration and exec-path options', () => {
      const gitAttacks = [
        'git -c core.pager=calc status',
        'git --config-env=foo=bar status',
        'git --exec-path=/tmp status',
        'git --upload-pack=calc status',
        'git config core.pager evil'
      ];
      for (const cmd of gitAttacks) {
        const res = CommandClassifier.classify(cmd);
        assert.strictEqual(
          res.tier,
          CommandTier.TIER_4_PROHIBITED,
          `Expected '${cmd}' to be classified as Tier 4 Prohibited`
        );
      }
    });
  });
});
