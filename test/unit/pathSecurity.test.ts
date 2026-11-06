import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentToolService } from '../../src/services/agentToolService';
import { resetMockState, mockState, setMockWorkspaceFolders, MockUri, mockFs } from '../mocks/vscodeMock';

describe('Path Resolution & Security Containment Baseline', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(() => {
    resetMockState(testRoot);
  });

  it('should resolve standard relative paths within workspace root', () => {
    const relPath = 'Backend.Api/Program.cs';
    const uri = AgentToolService.getFileUri(relPath);
    const expected = path.normalize(path.join(testRoot, relPath));
    assert.strictEqual(uri.fsPath, expected);
  });

  it('should strip leading slashes and backslashes', () => {
    const uri1 = AgentToolService.getFileUri('/src/index.ts');
    assert.strictEqual(uri1.fsPath, path.normalize(path.join(testRoot, 'src/index.ts')));

    const uri2 = AgentToolService.getFileUri('\\src\\index.ts');
    assert.strictEqual(uri2.fsPath, path.normalize(path.join(testRoot, 'src/index.ts')));
  });

  it('should handle Windows-style backslash relative paths', () => {
    const relPath = 'Frontend.Client\\src\\app\\app.component.ts';
    const uri = AgentToolService.getFileUri(relPath);
    const expected = path.normalize(path.join(testRoot, 'Frontend.Client/src/app/app.component.ts'));
    assert.strictEqual(uri.fsPath, expected);
  });

  it('should reject path traversal attempts outside workspace root', () => {
    const maliciousPaths = [
      '../../Windows/System32/cmd.exe',
      '../../../etc/passwd',
      '..\\..\\sensitive.env',
      'subfolder/../../outside.txt',
      'sub/./../../outside.txt',
      'sub/..\\..\\outside.txt'
    ];

    for (const p of maliciousPaths) {
      assert.throws(
        () => AgentToolService.getFileUri(p),
        /Access Denied|traversal|outside.*workspace/i,
        `Expected traversal path "${p}" to be rejected`
      );
    }
  });

  it('should reject UNC paths and null bytes', () => {
    const uncPaths = [
      '\\\\malicious-smb\\share\\exploit.ps1',
      '//malicious-smb/share/exploit.ps1'
    ];

    for (const p of uncPaths) {
      assert.throws(
        () => AgentToolService.getFileUri(p),
        /Access Denied.*UNC/i,
        `Expected UNC path "${p}" to be rejected`
      );
    }

    assert.throws(
      () => AgentToolService.getFileUri('src/\0malicious.ts'),
      /Access Denied.*null bytes/i,
      'Expected null-byte path to be rejected'
    );
  });

  it('should reject absolute paths outside the workspace', () => {
    const outsidePaths = [
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'C:/Windows/win.ini',
      'D:\\OtherDrive\\secret.env'
    ];

    for (const p of outsidePaths) {
      assert.throws(
        () => AgentToolService.getFileUri(p),
        /Access Denied|outside.*workspace/i,
        `Expected outside absolute path "${p}" to be rejected`
      );
    }
  });

  it('should block agent access to internal extension state (.vscode/local-copilot/)', () => {
    const internalPaths = [
      '.vscode/local-copilot/memory.json',
      '.vscode/local-copilot/whiteboard.json',
      '.vscode\\local-copilot\\memory.json',
      './.vscode/local-copilot/sub/config.json'
    ];

    for (const p of internalPaths) {
      assert.throws(
        () => AgentToolService.getFileUri(p),
        /Access Denied: Cannot access internal extension state/i,
        `Expected internal state path "${p}" to be blocked`
      );
    }
  });

  it('should support multi-root workspaces with deterministic folder matching', () => {
    setMockWorkspaceFolders([
      { name: 'Backend', uri: MockUri.file('C:/Projects/test-workspace/Backend') },
      { name: 'Frontend', uri: MockUri.file('C:/Projects/test-workspace/Frontend') }
    ]);

    // Explicit folder prefix
    const backendUri = AgentToolService.getFileUri('Backend/src/main.ts');
    assert.strictEqual(backendUri.fsPath, path.normalize('C:/Projects/test-workspace/Backend/src/main.ts'));

    const frontendUri = AgentToolService.getFileUri('Frontend/src/app.ts');
    assert.strictEqual(frontendUri.fsPath, path.normalize('C:/Projects/test-workspace/Frontend/src/app.ts'));

    // Unqualified path in multi-root workspace should be rejected for ambiguity
    assert.throws(
      () => AgentToolService.getFileUri('unqualified/file.ts'),
      /Ambiguous Workspace Folder/i
    );

    // Folder traversal attempt should be rejected
    assert.throws(
      () => AgentToolService.getFileUri('Backend/../../outside.txt'),
      /Access Denied|traversal/i
    );
  });

  it('should validate remote URI scheme and authority', () => {
    setMockWorkspaceFolders([
      { name: 'RemoteProject', uri: new MockUri('/home/user/project', 'vscode-remote', 'ssh-remote+myserver') }
    ]);

    // Matching scheme and authority
    const valid = AgentToolService.resolveSecurePath('vscode-remote://ssh-remote+myserver/home/user/project/src/index.ts');
    assert.strictEqual(valid.uri.scheme, 'vscode-remote');
    assert.strictEqual(valid.uri.authority, 'ssh-remote+myserver');

    // Mismatched scheme
    assert.throws(
      () => AgentToolService.resolveSecurePath('file:///home/user/project/src/index.ts'),
      /outside permitted workspace schemes/i
    );

    // Mismatched authority
    assert.throws(
      () => AgentToolService.resolveSecurePath('vscode-remote://other-host/home/user/project/src/index.ts'),
      /outside permitted workspace schemes/i
    );

    // Traversal inside remote URI
    assert.throws(
      () => AgentToolService.resolveSecurePath('vscode-remote://ssh-remote+myserver/home/user/project/../../etc/passwd'),
      /traversal/i
    );
  });

  it('should fail closed with sanitized error messages across all agent tools', async () => {
    const malicious = '../../etc/passwd';

    const viewResult = await AgentToolService.viewFileRange(malicious, 1, 10);
    assert.match(viewResult, /Error viewing file range: Access Denied/i);

    const strResult = await AgentToolService.strReplace(malicious, 'root', 'hacked');
    assert.strictEqual(strResult.success, false);
    assert.match(strResult.output, /Access Denied/i);

    const createResult = await AgentToolService.createFile(malicious, 'payload');
    assert.strictEqual(createResult.success, false);
    assert.match(createResult.output, /Access Denied/i);

    const patchResult = await AgentToolService.applyPatch(malicious, '@@ -1 +1 @@\n-a\n+b');
    assert.strictEqual(patchResult.success, false);
    assert.match(patchResult.output, /Access Denied/i);

    const listResult = await AgentToolService.listDir('../../');
    assert.match(listResult, /Error listing directory.*Access Denied/i);

    const diagResult = AgentToolService.getDiagnostics(malicious);
    assert.match(diagResult, /Error getting diagnostics: Access Denied/i);
  });

  it('should validate and harden getTrustedInternalStateUri against escape attempts', () => {
    // Legitimate internal storage paths
    const memUri = AgentToolService.getTrustedInternalStateUri('memory.json');
    assert.strictEqual(memUri.fsPath, path.normalize(path.join(testRoot, '.vscode/local-copilot/memory.json')));

    const wbUri = AgentToolService.getTrustedInternalStateUri('whiteboard.json');
    assert.strictEqual(wbUri.fsPath, path.normalize(path.join(testRoot, '.vscode/local-copilot/whiteboard.json')));

    // Traversal attempts
    assert.throws(
      () => AgentToolService.getTrustedInternalStateUri('../../escape.txt'),
      /Access Denied.*traversal/i
    );

    // Empty or whitespace subpath
    assert.throws(
      () => AgentToolService.getTrustedInternalStateUri(''),
      /Access Denied.*Empty subpath/i
    );

    // Null bytes
    assert.throws(
      () => AgentToolService.getTrustedInternalStateUri('memory\0.json'),
      /Access Denied.*null bytes/i
    );

    // Absolute and UNC paths
    assert.throws(
      () => AgentToolService.getTrustedInternalStateUri('C:\\Windows\\win.ini'),
      /Access Denied.*Absolute or UNC/i
    );
    assert.throws(
      () => AgentToolService.getTrustedInternalStateUri('/etc/passwd'),
      /Access Denied.*Absolute or UNC/i
    );
    assert.throws(
      () => AgentToolService.getTrustedInternalStateUri('\\\\server\\share\\data.json'),
      /Access Denied.*Absolute or UNC/i
    );
  });

  it('should preserve scheme, authority, and containment for AppGeneratorService URI paths', () => {
    // 1. Local workspace URI
    const localRootUri = MockUri.file(testRoot);
    const localTargetUri = MockUri.joinPath(localRootUri, 'Backend.Api', 'Models', 'TaskItem.cs');
    const localResolved = AgentToolService.resolveSecurePath(localTargetUri.toString(), { allowNewFile: true });

    assert.strictEqual(localResolved.uri.scheme, 'file');
    assert.strictEqual(
      localResolved.uri.fsPath,
      path.normalize(path.join(testRoot, 'Backend.Api/Models/TaskItem.cs'))
    );
    // Ensure no prefix duplication
    assert.strictEqual(localResolved.uri.fsPath.split('test-workspace').length, 2);

    // 2. Remote workspace URI
    setMockWorkspaceFolders([
      { name: 'RemoteWS', uri: new MockUri('/home/user/project', 'vscode-remote', 'ssh-remote+myserver') }
    ]);

    const remoteRootUri = new MockUri('/home/user/project', 'vscode-remote', 'ssh-remote+myserver');
    const remoteTargetUri = MockUri.joinPath(remoteRootUri, 'Backend.Api', 'Models', 'TaskItem.cs');
    const remoteResolved = AgentToolService.resolveSecurePath(remoteTargetUri.toString(), { allowNewFile: true });

    assert.strictEqual(remoteResolved.uri.scheme, 'vscode-remote');
    assert.strictEqual(remoteResolved.uri.authority, 'ssh-remote+myserver');
    assert.strictEqual(remoteResolved.uri.path, '/home/user/project/Backend.Api/Models/TaskItem.cs');
  });

  it('should enforce strict multi-root behavior in listDir', async () => {
    // 1. Single-root empty path listing succeeds
    resetMockState('C:/Projects/single-ws');
    const singleFolderUri = MockUri.file('C:/Projects/single-ws');
    setMockWorkspaceFolders([{ name: 'single-ws', uri: singleFolderUri }]);
    mockFs.setFile(path.normalize('C:/Projects/single-ws/file1.txt'), 'content');

    const singleListing = await AgentToolService.listDir('');
    assert.ok(singleListing.includes('file1.txt'), 'Expected single-root root listing to include file1.txt');

    // 2. Multi-root empty path listing is rejected for ambiguity
    setMockWorkspaceFolders([
      { name: 'Backend', uri: MockUri.file('C:/Projects/multi/Backend') },
      { name: 'Frontend', uri: MockUri.file('C:/Projects/multi/Frontend') }
    ]);

    const emptyMultiListing = await AgentToolService.listDir('');
    assert.match(emptyMultiListing, /Ambiguous Workspace Folder/i);

    // 3. Multi-root explicit folder listing succeeds
    mockFs.setFile(path.normalize('C:/Projects/multi/Backend/Program.cs'), 'using System;');
    const backendListing = await AgentToolService.listDir('Backend');
    assert.ok(backendListing.includes('Program.cs'), 'Expected explicit Backend folder listing to include Program.cs');

    // 4. Duplicate folder names reject listing for ambiguity
    setMockWorkspaceFolders([
      { name: 'App', uri: MockUri.file('C:/Projects/multi/App1') },
      { name: 'App', uri: MockUri.file('C:/Projects/multi/App2') }
    ]);

    const ambiguousListing = await AgentToolService.listDir('App');
    assert.match(ambiguousListing, /Ambiguous Workspace Folder: Multiple workspace folders named "App"/i);
  });

  describe('Physical Filesystem Symlink & Junction Containment', () => {
    let tempBaseDir: string;
    let tempWsDir: string;
    let tempOutsideDir: string;
    let junctionPath: string;

    beforeEach(() => {
      tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sec-test-'));
      tempWsDir = path.join(tempBaseDir, 'workspace');
      tempOutsideDir = path.join(tempBaseDir, 'outside');

      fs.mkdirSync(tempWsDir, { recursive: true });
      fs.mkdirSync(tempOutsideDir, { recursive: true });

      // Create an outside secret file
      fs.writeFileSync(path.join(tempOutsideDir, 'secret.env'), 'API_KEY=SUPER_SECRET_123');

      // Create a valid file inside workspace
      fs.writeFileSync(path.join(tempWsDir, 'valid.txt'), 'legitimate workspace file');

      // Set up workspace folder pointing to the physical tempWsDir
      setMockWorkspaceFolders([
        { name: 'PhysWorkspace', uri: MockUri.file(tempWsDir) }
      ]);
    });

    afterEach(() => {
      // Safely cleanup junction first (if exists) without deleting outside directory contents
      if (junctionPath && fs.existsSync(junctionPath)) {
        try {
          fs.unlinkSync(junctionPath);
        } catch {
          try {
            fs.rmdirSync(junctionPath);
          } catch {}
        }
      }

      // Cleanup temp directories
      if (tempBaseDir && fs.existsSync(tempBaseDir)) {
        try {
          fs.rmSync(tempBaseDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('should reject resolving an existing file through a directory junction pointing outside the workspace', function () {
      junctionPath = path.join(tempWsDir, 'linked_junction');
      try {
        fs.symlinkSync(tempOutsideDir, junctionPath, 'junction');
      } catch (err: any) {
        if (process.platform !== 'win32') {
          try {
            fs.symlinkSync(tempOutsideDir, junctionPath, 'dir');
          } catch {
            return this.skip();
          }
        } else {
          assert.fail(`Failed to create directory junction on Windows: ${err.message}`);
        }
      }

      // Junction now points from inside workspace to tempOutsideDir
      assert.strictEqual(fs.existsSync(path.join(tempWsDir, 'linked_junction', 'secret.env')), true);

      // Attempting to resolve secret.env through the junction MUST fail closed
      assert.throws(
        () => AgentToolService.resolveSecurePath('linked_junction/secret.env'),
        /Access Denied.*symbolic link or junction/i,
        'Expected traversal through junction to be blocked'
      );

      // Verify the outside directory and secret file remain completely intact
      assert.strictEqual(fs.existsSync(path.join(tempOutsideDir, 'secret.env')), true);
    });

    it('should reject creating a new file beneath a directory junction pointing outside the workspace', function () {
      junctionPath = path.join(tempWsDir, 'linked_junction');
      try {
        fs.symlinkSync(tempOutsideDir, junctionPath, 'junction');
      } catch (err: any) {
        if (process.platform !== 'win32') {
          try {
            fs.symlinkSync(tempOutsideDir, junctionPath, 'dir');
          } catch {
            return this.skip();
          }
        } else {
          assert.fail(`Failed to create directory junction on Windows: ${err.message}`);
        }
      }

      // Attempting to resolve a new file under the junction with allowNewFile: true
      assert.throws(
        () => AgentToolService.resolveSecurePath('linked_junction/new_evil_file.txt', { allowNewFile: true }),
        /Access Denied.*Parent directory.*resolves outside/i,
        'Expected new file creation through junction to be blocked'
      );

      // Verify no file was created in the outside directory
      assert.strictEqual(fs.existsSync(path.join(tempOutsideDir, 'new_evil_file.txt')), false);
    });

    it('should fail closed when canonicalization fails unexpectedly', () => {
      // Create a physical file inside workspace
      const targetFile = path.join(tempWsDir, 'file.txt');
      fs.writeFileSync(targetFile, 'content');

      // Mock fs.realpathSync.native to throw an unexpected filesystem error (e.g. EPERM / EACCES)
      const originalRealpath = fs.realpathSync.native;
      try {
        (fs.realpathSync as any).native = () => {
          const err: any = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        };

        assert.throws(
          () => AgentToolService.resolveSecurePath('file.txt'),
          /Access Denied: Canonicalization failed/i,
          'Expected resolveSecurePath to fail closed when canonicalization fails'
        );
      } finally {
        (fs.realpathSync as any).native = originalRealpath;
      }
    });
  });
});
