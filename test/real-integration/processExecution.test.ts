import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentToolService } from '../../src/services/agentToolService';
import { ExecutableResolver } from '../../src/services/executableResolver';

describe('Phase 8.1a: Real Process Spawning & Project Execution Tier', () => {
  let tempProjectDir: string;

  before(() => {
    tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proc-test-'));
    // Setup a real throwaway Node project fixture
    const packageJson = {
      name: 'fixture-project',
      version: '1.0.0',
      scripts: {
        test: 'node -e "console.log(\'FIXTURE_REAL_PROCESS_SUCCESS\'); process.exit(0);"'
      }
    };
    fs.writeFileSync(path.join(tempProjectDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
  });

  after(() => {
    try {
      fs.rmSync(tempProjectDir, { recursive: true, force: true });
    } catch {}
  });

  it('should really spawn node --version and return valid semver output with exitCode 0', async () => {
    const result = await AgentToolService.executeCommand('node --version');
    assert.strictEqual(result.exitCode, 0, `Expected exitCode 0, got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.match(result.stdout.trim(), /^v\d+\.\d+\.\d+/, `Output should be semver: "${result.stdout}"`);
  });

  it('should really spawn git --version with exitCode 0', async () => {
    const result = await AgentToolService.executeCommand('git --version');
    assert.strictEqual(result.exitCode, 0, `Expected exitCode 0, got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.match(result.stdout.trim(), /git version/i, `Output should contain "git version": "${result.stdout}"`);
  });

  it('should really spawn npm --version on Windows and Unix with exitCode 0 without shell', async () => {
    const resolved = ExecutableResolver.resolveCommand('npm', ['--version']);
    assert.ok(resolved.executable, 'Executable must be resolved');
    if (process.platform === 'win32') {
      assert.ok(resolved.executable.endsWith('node.exe'), `On Windows, npm must resolve to node.exe entrypoint, got: ${resolved.executable}`);
    }

    const result = await AgentToolService.executeCommand('npm --version');
    assert.strictEqual(result.exitCode, 0, `Expected exitCode 0, got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/, `npm --version should return semver: "${result.stdout}"`);
  });

  it('should execute real npm test in fixture project and capture real stdout', async () => {
    const prevCwd = process.cwd();
    try {
      process.chdir(tempProjectDir);
      const result = await AgentToolService.executeCommand('npm test');
      assert.strictEqual(result.exitCode, 0, `npm test failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('FIXTURE_REAL_PROCESS_SUCCESS'),
        `stdout must contain fixture sentinel: ${result.stdout}`
      );
    } finally {
      process.chdir(prevCwd);
    }
  });
});
