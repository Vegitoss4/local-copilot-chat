import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');

    // The path to the extension test runner script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Use local existing VS Code binary if present to avoid external network downloads
    const localCodeExe = path.resolve(__dirname, '../../../.vscode-test/vscode-win32-x64-archive-1.145.1/Code.exe');
    const vscodeExecutablePath = fs.existsSync(localCodeExe) ? localCodeExe : undefined;

    const testWorkspace = path.resolve(__dirname, '../../../.vscode-test/test-workspace');
    if (!fs.existsSync(testWorkspace)) {
      fs.mkdirSync(testWorkspace, { recursive: true });
    }

    // Run the integration test in real extension host
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions', testWorkspace]
    });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

main();
