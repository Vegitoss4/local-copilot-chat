import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ApprovalPolicyEngine,
  PolicyEvaluationResult
} from '../../src/services/approvalPolicyEngine';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 11.6: Unified Approval Policy Engine & Grant Storage Suite', () => {
  let engine: ApprovalPolicyEngine;
  const tempDir = 'C:\\Projects\\test-workspace';

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'policy-workspace', uri: MockUri.file(tempDir), index: 0 }
    ]);
    ApprovalPolicyEngine.resetInstance();
    engine = ApprovalPolicyEngine.getInstance();
  });

  afterEach(() => {
    engine.revokeAllGrants();
    ApprovalPolicyEngine.resetInstance();
  });

  describe('Command Tier Evaluation & Untrusted Workspaces', () => {
    it('should deny prohibited Tier 4 commands completely', () => {
      const res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'rm -rf /'
      });

      assert.strictEqual(res.decision, 'deny');
      assert.strictEqual(res.riskLevel, 'prohibited');
      assert.ok(res.reason.includes('Prohibited command'));
    });

    it('should allow Tier 1 safe read-only commands in autonomous mode', () => {
      const res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'git status --short',
        isAutonomousMode: true
      });

      assert.strictEqual(res.decision, 'allow');
      assert.strictEqual(res.riskLevel, 'low');
    });

    it('should require prompt for Tier 2 project execution commands without grant', () => {
      const res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'npm test',
        isAutonomousMode: true
      });

      assert.strictEqual(res.decision, 'prompt');
      assert.strictEqual(res.riskLevel, 'medium');
      assert.ok(res.reason.includes('requires explicit approval'));
    });

    it('should deny command execution in untrusted workspaces', () => {
      // Mock untrusted workspace
      (vscode.workspace as any).isTrusted = false;

      const res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'npm run build'
      });

      assert.strictEqual(res.decision, 'deny');
      assert.strictEqual(res.riskLevel, 'prohibited');
      assert.ok(res.reason.includes('Untrusted Workspaces'));

      // Restore trust
      (vscode.workspace as any).isTrusted = true;
    });
  });

  describe('Sensitive Target Path Defense', () => {
    it('should enforce prompt for sensitive targets like .env and .git even in autonomous mode', () => {
      const envRes = engine.evaluate({
        toolName: 'writeFile',
        targetPath: '.env',
        isAutonomousMode: true
      });

      assert.strictEqual(envRes.decision, 'prompt');
      assert.strictEqual(envRes.riskLevel, 'high');
      assert.ok(envRes.reason.includes('sensitive target'));

      const gitRes = engine.evaluate({
        toolName: 'writeFile',
        targetPath: '.git/config',
        isAutonomousMode: true
      });

      assert.strictEqual(gitRes.decision, 'prompt');
      assert.strictEqual(gitRes.riskLevel, 'high');
    });

    it('should allow modification of non-sensitive files in autonomous mode', () => {
      const res = engine.evaluate({
        toolName: 'writeFile',
        targetPath: 'src/utils/math.ts',
        isAutonomousMode: true
      });

      assert.strictEqual(res.decision, 'allow');
      assert.strictEqual(res.riskLevel, 'medium');
    });
  });

  describe('Grant Storage, Matching & TTL Expiration', () => {
    it('should auto-allow command when active grant matches', () => {
      engine.addGrant('cmd:npm test', 'session', 60000);

      const res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'npm test'
      });

      assert.strictEqual(res.decision, 'allow');
      assert.ok(res.matchedGrant);
      assert.strictEqual(res.matchedGrant.pattern, 'cmd:npm test');
    });

    it('should support wildcard grant patterns', () => {
      engine.addGrant('tool:writeFile:src/*', 'session', 60000);

      const res = engine.evaluate({
        toolName: 'writeFile',
        targetPath: 'src/components/Header.tsx',
        isAutonomousMode: false
      });

      assert.strictEqual(res.decision, 'allow');
      assert.ok(res.matchedGrant);
    });

    it('should expire grants after TTL elapses', async () => {
      // Add short grant (20ms)
      engine.addGrant('cmd:npm run test:quick', 'once', 20);

      // Verify active immediately
      let res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'npm run test:quick'
      });
      assert.strictEqual(res.decision, 'allow');

      // Wait for expiration
      await new Promise(r => setTimeout(r, 35));

      // Should prompt again after expiration
      res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'npm run test:quick'
      });
      assert.strictEqual(res.decision, 'prompt');
    });

    it('should revoke all grants on revokeAllGrants()', () => {
      engine.addGrant('cmd:git push', 'session', 60000);
      assert.strictEqual(engine.getActiveGrants().length, 1);

      engine.revokeAllGrants();
      assert.strictEqual(engine.getActiveGrants().length, 0);

      const res = engine.evaluate({
        toolName: 'executeCommand',
        command: 'git push'
      });
      assert.strictEqual(res.decision, 'prompt');
    });
  });
});
