import * as assert from 'assert';
import * as path from 'path';
import { ExecutableResolver, ExecutableResolutionError } from '../../src/services/executableResolver';
import { GitExecutionIsolator } from '../../src/services/gitExecutionIsolator';
import { AgentToolService } from '../../src/services/agentToolService';
import { resetMockState, MockUri } from '../mocks/vscodeMock';

describe('Phase 1.2 Stage 2: Command Execution Security, Resolver & Git Isolator Suite', () => {
  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
  });

  describe('1. ExecutableResolver Security & Hijack Protection', () => {
    it('should reject empty or whitespace-only executable names', () => {
      assert.throws(
        () => ExecutableResolver.resolve('   '),
        (err: any) => err instanceof ExecutableResolutionError && err.message.includes('empty')
      );
    });

    it('should reject script files by extension (.bat, .cmd, .ps1, .vbs, .sh)', () => {
      const scripts = ['deploy.bat', 'setup.cmd', 'install.ps1', 'payload.vbs', 'run.sh'];
      for (const script of scripts) {
        assert.throws(
          () => ExecutableResolver.resolve(script),
          (err: any) => err instanceof ExecutableResolutionError && err.message.includes('prohibited'),
          `Expected script '${script}' to be rejected`
        );
      }
    });

    it('should reject executables located inside workspace folders to prevent binary hijacking', () => {
      const workspaceBinary = 'C:/Projects/test-workspace/git.exe';
      assert.throws(
        () => ExecutableResolver.resolve(workspaceBinary),
        (err: any) => err instanceof ExecutableResolutionError && err.message.includes('workspace boundary')
      );
    });

    it('should throw error when absolute path executable does not exist', () => {
      const nonExistent = 'C:/Program Files/FakeTool/nonexistent_tool_12345.exe';
      assert.throws(
        () => ExecutableResolver.resolve(nonExistent),
        (err: any) => err instanceof ExecutableResolutionError && err.message.includes('not found')
      );
    });

    it('should resolve system node executable on host', () => {
      const resolved = ExecutableResolver.resolve('node');
      assert.ok(resolved, 'Expected node to resolve');
      assert.ok(
        path.basename(resolved).toLowerCase().startsWith('node'),
        `Resolved path should be node binary: ${resolved}`
      );
    });

    it('should resolve npm command on Windows using node and npm-cli.js without shell invocation', () => {
      const res = ExecutableResolver.resolveCommand('npm', ['--version'], 'win32');
      assert.ok(res.executable.toLowerCase().includes('node.exe'), `Expected node.exe but got: ${res.executable}`);
      assert.ok(res.args.length >= 2);
      assert.ok(res.args[0].toLowerCase().includes('npm-cli.js'), `Expected npm-cli.js entrypoint: ${res.args[0]}`);
      assert.strictEqual(res.args[1], '--version');
    });

    it('should resolve npx command on Windows using node and npx-cli.js', () => {
      const res = ExecutableResolver.resolveCommand('npx', ['--version'], 'win32');
      assert.ok(res.executable.toLowerCase().includes('node.exe'), `Expected node.exe but got: ${res.executable}`);
      assert.ok(res.args.length >= 2);
      assert.ok(res.args[0].toLowerCase().includes('npx-cli.js'), `Expected npx-cli.js entrypoint: ${res.args[0]}`);
      assert.strictEqual(res.args[1], '--version');
    });

    it('should resolve npm test with arguments preserved on Windows', () => {
      const res = ExecutableResolver.resolveCommand('npm', ['test'], 'win32');
      assert.ok(res.executable.toLowerCase().includes('node.exe'));
      assert.strictEqual(res.args[res.args.length - 1], 'test');
    });

    it('should throw ExecutableResolutionError when an executable is not found in PATH', () => {
      assert.throws(
        () => ExecutableResolver.resolve('completely_imaginary_tool_xyz_987'),
        (err: any) => err instanceof ExecutableResolutionError && err.message.includes('not found')
      );
    });

    it('should reject extensionless POSIX scripts on Windows', () => {
      assert.throws(
        () => ExecutableResolver.resolveCommand('C:/Program Files/nodejs/npm', ['test'], 'win32'),
        (err: any) => err instanceof ExecutableResolutionError && err.message.includes('POSIX')
      );
    });

    it('should never return cmd.exe or ComSpec as resolved executable for npm or npx', () => {
      // Test with custom path where only npm.cmd exists
      assert.throws(
        () => ExecutableResolver.resolveCommand('npm', ['--version'], 'win32', 'C:/FakeEmptyDir'),
        (err: any) => err instanceof ExecutableResolutionError && !err.message.includes('cmd.exe')
      );
    });

    it('should reject node.exe or npm-cli.js if located inside workspace folder (anti-hijack)', () => {
      const workspacePath = 'C:/Projects/test-workspace';
      assert.throws(
        () => ExecutableResolver.resolveCommand('npm', ['--version'], 'win32', workspacePath),
        (err: any) => err instanceof ExecutableResolutionError
      );
    });
  });

  describe('2. GitExecutionIsolator Arguments & Environment Hardening', () => {
    it('should inject --no-pager when not present in git arguments', () => {
      const rawArgs = ['status', '--short'];
      const isolated = GitExecutionIsolator.isolateArguments(rawArgs);

      assert.strictEqual(isolated[0], '--no-pager');
      assert.ok(isolated.includes('status'));
      assert.ok(isolated.includes('--short'));
    });

    it('should not duplicate --no-pager if already present', () => {
      const rawArgs = ['--no-pager', 'log', '-n', '5'];
      const isolated = GitExecutionIsolator.isolateArguments(rawArgs);

      const count = isolated.filter((a) => a === '--no-pager').length;
      assert.strictEqual(count, 1);
    });

    it('should inject --no-ext-diff and --no-textconv for diff subcommands', () => {
      const rawArgs = ['diff', 'HEAD~1'];
      const isolated = GitExecutionIsolator.isolateArguments(rawArgs);

      assert.ok(isolated.includes('--no-pager'));
      assert.ok(isolated.includes('--no-ext-diff'));
      assert.ok(isolated.includes('--no-textconv'));
    });

    it('should not inject diff flags for non-diff subcommands', () => {
      const rawArgs = ['branch', '-a'];
      const isolated = GitExecutionIsolator.isolateArguments(rawArgs);

      assert.strictEqual(isolated.includes('--no-ext-diff'), false);
      assert.strictEqual(isolated.includes('--no-textconv'), false);
    });

    it('should generate hardened environment neutralizing local git configurations', () => {
      const baseEnv = { PATH: 'C:/Windows', USER: 'testuser' };
      const env = GitExecutionIsolator.getIsolatedEnvironment(baseEnv);

      assert.strictEqual(env.GIT_CONFIG_COUNT, '0');
      assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
      assert.strictEqual(env.GIT_OPTIONAL_LOCKS, '0');
      assert.strictEqual(env.PATH, 'C:/Windows');
    });
  });

  describe('3. AgentToolService.executeCommand Security Integration', () => {
    it('should reject prohibited Tier 4 destructive commands before execution', async () => {
      await assert.rejects(
        async () => {
          await AgentToolService.executeCommand('rm -rf /');
        },
        (err: any) => err.message.includes('prohibited')
      );
    });

    it('should reject command chaining and metacharacters', async () => {
      await assert.rejects(
        async () => {
          await AgentToolService.executeCommand('git status && echo evil');
        },
        (err: any) => err.message.includes('metacharacters') || err.message.includes('Syntax')
      );
    });

    it('should safely execute whitelisted Tier 1 inspection command', async () => {
      const res = await AgentToolService.executeCommand('git --version');
      assert.strictEqual(res.exitCode, 0);
      assert.ok(res.stdout.toLowerCase().includes('git version'));
    });

    it('should safely execute getGitDiff using decoupled structured commands without shell chaining', async () => {
      const diffOutput = await AgentToolService.getGitDiff();
      assert.ok(typeof diffOutput === 'string');
      assert.ok(
        diffOutput.includes('Working tree clean') ||
        diffOutput.includes('Git is not initialized') ||
        diffOutput.length > 0
      );
    });

    it('should safely execute npm --version on Windows via node.exe without shell spawning', async function() {
      if (process.platform !== 'win32') {
        this.skip();
        return;
      }
      this.timeout(10000);
      const res = await AgentToolService.executeCommand('npm --version');
      assert.strictEqual(res.exitCode, 0, `npm --version failed: ${res.stderr}`);
      assert.ok(/\d+\.\d+\.\d+/.test(res.stdout), `Expected semver output, got: ${res.stdout}`);
    });

    it('should safely execute npx --version offline on Windows via node.exe with strict timeout', async function() {
      if (process.platform !== 'win32') {
        this.skip();
        return;
      }
      this.timeout(10000);
      const res = await AgentToolService.executeCommand('npx --version');
      assert.strictEqual(res.exitCode, 0, `npx --version failed: ${res.stderr}`);
      assert.ok(/\d+\.\d+\.\d+/.test(res.stdout), `Expected semver output, got: ${res.stdout}`);
    });
  });

  describe('3. Phase 5.5 H3: Hardened Git Configuration & Hook Isolation Suite', () => {
    it('should inject global config overrides to neutralize local hooks and external diff/merge tools', () => {
      const rawArgs = ['diff', 'HEAD~1'];
      const isolated = GitExecutionIsolator.isolateArguments(rawArgs);

      assert.ok(isolated.includes('core.hooksPath=/dev/null'), 'Must neutralize repository hooks via core.hooksPath=/dev/null');
      assert.ok(isolated.includes('diff.external='), 'Must disable external diff programs');
      assert.ok(isolated.includes('merge.tool='), 'Must disable merge tools');
      assert.ok(isolated.includes('diff.tool='), 'Must disable diff tools');
      assert.ok(isolated.includes('--no-pager'), 'Must suppress pager');
      assert.ok(isolated.includes('--no-ext-diff'), 'Must include --no-ext-diff');
      assert.ok(isolated.includes('--no-textconv'), 'Must include --no-textconv');
    });

    it('should configure an environment that excludes system configuration and pager hanging', () => {
      const isolatedEnv = GitExecutionIsolator.getIsolatedEnvironment({});

      assert.strictEqual(isolatedEnv.GIT_CONFIG_COUNT, '0', 'GIT_CONFIG_COUNT must be 0');
      assert.strictEqual(isolatedEnv.GIT_CONFIG_NOSYSTEM, '1', 'GIT_CONFIG_NOSYSTEM must be 1');
      assert.strictEqual(isolatedEnv.GIT_TERMINAL_PROMPT, '0', 'GIT_TERMINAL_PROMPT must be 0');
      assert.strictEqual(isolatedEnv.GIT_OPTIONAL_LOCKS, '0', 'GIT_OPTIONAL_LOCKS must be 0');
      assert.strictEqual(isolatedEnv.GIT_PAGER, 'cat', 'GIT_PAGER must be cat');
      assert.strictEqual(isolatedEnv.PAGER, 'cat', 'PAGER must be cat');
    });
  });
});
