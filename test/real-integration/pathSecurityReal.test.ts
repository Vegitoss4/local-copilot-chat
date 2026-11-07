import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { PathSecurity, WorkspaceSecurityError } from '../../src/services/pathSecurity';
import { resetMockState, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Phase 8.1c: Real Filesystem, Symlink & Junction Path Security Tier', function () {
  this.timeout(10000);

  let tempWorkspaceDir: string;
  let tempOutsideDir: string;

  beforeEach(() => {
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-ws-'));
    tempOutsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-outside-'));

    resetMockState(tempWorkspaceDir);
    setMockWorkspaceFolders([
      {
        uri: vscode.Uri.file(tempWorkspaceDir),
        name: 'test-ws',
        index: 0
      }
    ]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
    try {
      fs.rmSync(tempOutsideDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  });

  it('should reject access to files through symlink or junction escaping workspace root', () => {
    // Put a secret outside
    const outsideFile = path.join(tempOutsideDir, 'secret_passwords.txt');
    fs.writeFileSync(outsideFile, 'super_secret_token=12345', 'utf8');

    // Create a symlink or junction inside workspace pointing outside
    const linkPath = path.join(tempWorkspaceDir, 'link_to_outside');
    const isWin = process.platform === 'win32';
    try {
      if (isWin) {
        fs.symlinkSync(tempOutsideDir, linkPath, 'junction');
      } else {
        fs.symlinkSync(tempOutsideDir, linkPath, 'dir');
      }
    } catch (err: any) {
      // On Windows without Developer Mode, junction is unprivileged; symlink requires privilege
      if (isWin) {
        fs.symlinkSync(tempOutsideDir, linkPath, 'junction');
      } else {
        throw err;
      }
    }

    assert.throws(
      () => {
        PathSecurity.validatePath('link_to_outside/secret_passwords.txt');
      },
      (err: any) => {
        return err instanceof WorkspaceSecurityError &&
          err.message.includes('resolves outside the permitted workspace via symbolic link or junction');
      }
    );
  });

  it('should permit access through internal symlink pointing within workspace', () => {
    const internalDir = path.join(tempWorkspaceDir, 'internal_src');
    fs.mkdirSync(internalDir);
    const internalFile = path.join(internalDir, 'module.ts');
    fs.writeFileSync(internalFile, 'export const val = 42;', 'utf8');

    const linkPath = path.join(tempWorkspaceDir, 'alias_src');
    const isWin = process.platform === 'win32';
    if (isWin) {
      fs.symlinkSync(internalDir, linkPath, 'junction');
    } else {
      fs.symlinkSync(internalDir, linkPath, 'dir');
    }

    const validated = PathSecurity.validatePath('alias_src/module.ts');
    assert.ok(validated);
    assert.strictEqual(fs.existsSync(validated.uri.fsPath), true);
  });

  it('should reject nonexistent target whose parent resolves outside workspace', () => {
    // An escaping absolute path or parent traversal
    const outsideTarget = path.join(tempOutsideDir, 'new_script.ts');

    assert.throws(
      () => {
        PathSecurity.validatePath(outsideTarget, undefined, { allowNewFile: true });
      },
      (err: any) => {
        return err instanceof WorkspaceSecurityError;
      }
    );
  });

  it('should reject UNC network share paths on all platforms', () => {
    assert.throws(
      () => {
        PathSecurity.validatePath('\\\\192.168.1.100\\c$\\evil.txt');
      },
      (err: any) => {
        return err instanceof WorkspaceSecurityError && err.message.includes('UNC');
      }
    );

    assert.throws(
      () => {
        PathSecurity.validatePath('//smb-share/loot/passwords.txt');
      },
      (err: any) => {
        return err instanceof WorkspaceSecurityError && err.message.includes('UNC');
      }
    );
  });

  it('should reject paths containing null bytes', () => {
    assert.throws(
      () => {
        PathSecurity.validatePath('safe_file.txt\0.exe');
      },
      (err: any) => {
        return err instanceof WorkspaceSecurityError && err.message.includes('null bytes');
      }
    );
  });

  it('should reject attempts to access internal state directory', () => {
    assert.throws(
      () => {
        PathSecurity.validatePath('.vscode/local-copilot/tx-journal.json');
      },
      (err: any) => {
        return err instanceof WorkspaceSecurityError && err.message.includes('internal extension state');
      }
    );
  });
});
