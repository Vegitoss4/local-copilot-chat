import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { GitExecutionIsolator } from '../../src/services/gitExecutionIsolator';

describe('Phase 8.1b: Real Git Hook & Execution Isolation Tier', function () {
  this.timeout(10000);

  let tempRepoDir: string;
  let sentinelHookPath: string;

  beforeEach(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-isolation-test-'));
    sentinelHookPath = path.join(tempRepoDir, 'hook_ran.sentinel');

    // Initialize real git repo
    const init = spawnSync('git', ['init'], { cwd: tempRepoDir, encoding: 'utf8' });
    assert.strictEqual(init.status, 0, `git init failed: ${init.stderr}`);

    spawnSync('git', ['config', 'user.name', 'Test Isolator'], { cwd: tempRepoDir });
    spawnSync('git', ['config', 'user.email', 'isolator@example.com'], { cwd: tempRepoDir });

    // Install a pre-commit hook that drops a sentinel file or fails
    const hooksDir = path.join(tempRepoDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const isWindows = process.platform === 'win32';
    const hookFileName = isWindows ? 'pre-commit.bat' : 'pre-commit';
    const hookFile = path.join(hooksDir, hookFileName);

    if (isWindows) {
      fs.writeFileSync(hookFile, `@echo off\r\necho HOOK_EXECUTED > "${sentinelHookPath}"\r\nexit 1\r\n`, 'utf8');
    } else {
      fs.writeFileSync(hookFile, `#!/bin/sh\necho HOOK_EXECUTED > "${sentinelHookPath}"\nexit 1\n`, { encoding: 'utf8', mode: 0o755 });
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it('should neutralize repository hooks when running git with GitExecutionIsolator', () => {
    // Stage a new file
    const testFile = path.join(tempRepoDir, 'hello.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf8');

    spawnSync('git', ['add', 'hello.txt'], { cwd: tempRepoDir });

    // Commit using GitExecutionIsolator
    const baseArgs = ['commit', '-m', 'test commit'];
    const isolatedArgs = GitExecutionIsolator.isolateArguments(baseArgs);
    const isolatedEnv = GitExecutionIsolator.getIsolatedEnvironment(process.env);

    const result = spawnSync('git', isolatedArgs, {
      cwd: tempRepoDir,
      env: isolatedEnv,
      encoding: 'utf8'
    });

    // The commit should succeed and the pre-commit hook MUST NOT have run
    assert.strictEqual(result.status, 0, `Git commit failed: ${result.stderr} (stdout: ${result.stdout})`);
    assert.strictEqual(
      fs.existsSync(sentinelHookPath),
      false,
      'Pre-commit hook was executed despite GitExecutionIsolator overrides!'
    );
  });

  it('should neutralize external diff tool configuration', () => {
    // Configure a malicious/poisoned diff tool in repository config
    const sentinelDiff = path.join(tempRepoDir, 'diff_ran.sentinel');
    let externalDiffCmd: string;
    if (process.platform === 'win32') {
      const batPath = path.join(tempRepoDir, 'fake-diff.bat');
      fs.writeFileSync(batPath, `@echo off\r\necho DIFF > "${sentinelDiff}"\r\n`, 'utf8');
      externalDiffCmd = batPath.replace(/\\/g, '/');
    } else {
      const shPath = path.join(tempRepoDir, 'fake-diff.sh');
      fs.writeFileSync(shPath, `#!/bin/sh\necho DIFF > "${sentinelDiff}"\n`, { encoding: 'utf8', mode: 0o755 });
      externalDiffCmd = shPath;
    }

    spawnSync('git', ['config', 'diff.external', externalDiffCmd], { cwd: tempRepoDir });

    // Create a modified file
    const fileA = path.join(tempRepoDir, 'sample.txt');
    fs.writeFileSync(fileA, 'initial', 'utf8');
    spawnSync('git', ['add', 'sample.txt'], { cwd: tempRepoDir });
    spawnSync('git', ['commit', '-m', 'initial commit'], {
      cwd: tempRepoDir,
      env: GitExecutionIsolator.getIsolatedEnvironment(process.env)
    });

    fs.writeFileSync(fileA, 'modified', 'utf8');

    // Run diff with isolator
    const isolatedArgs = GitExecutionIsolator.isolateArguments(['diff']);
    const res = spawnSync('git', isolatedArgs, {
      cwd: tempRepoDir,
      env: GitExecutionIsolator.getIsolatedEnvironment(process.env),
      encoding: 'utf8'
    });

    assert.strictEqual(res.status, 0);
    assert.strictEqual(
      fs.existsSync(sentinelDiff),
      false,
      'diff.external was invoked despite GitExecutionIsolator override!'
    );
  });

  it('should only inject --no-ext-diff for diff subcommands and not when diff is a branch name', () => {
    const branchArgs = GitExecutionIsolator.isolateArguments(['checkout', '-b', 'diff']);
    assert.strictEqual(
      branchArgs.includes('--no-ext-diff'),
      false,
      '--no-ext-diff was incorrectly injected into checkout command'
    );

    const diffArgs = GitExecutionIsolator.isolateArguments(['diff', 'HEAD']);
    assert.strictEqual(
      diffArgs.includes('--no-ext-diff'),
      true,
      '--no-ext-diff must be injected into diff command'
    );
  });
});
