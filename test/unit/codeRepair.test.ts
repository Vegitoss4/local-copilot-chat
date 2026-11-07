import * as assert from 'assert';
import { CodeRepairEngine, RepairAttempt } from '../../src/services/codeRepairEngine';

describe('Phase 9.5: Iterative Code Repair with Regression Awareness Suite', () => {
  describe('Test Weakening Detection', () => {
    it('should detect when an agent tries to skip a failing test', () => {
      const target = "it('should calculate tax correctly', () => {";
      const replacement = "it.skip('should calculate tax correctly', () => {";
      const weakened = CodeRepairEngine.detectTestWeakening(target, replacement, 'test/unit/tax.test.ts');
      assert.strictEqual(weakened, true);
    });

    it('should detect when an agent uses xit or xtest to bypass failure', () => {
      const target = "it('should authenticate user', () => {";
      const replacement = "xit('should authenticate user', () => {";
      const weakened = CodeRepairEngine.detectTestWeakening(target, replacement, 'test/auth.spec.ts');
      assert.strictEqual(weakened, true);
    });

    it('should detect when assertions are stripped entirely from a test file', () => {
      const target = "const res = run();\nassert.strictEqual(res.status, 200);";
      const replacement = "const res = run();\n// todo check status";
      const weakened = CodeRepairEngine.detectTestWeakening(target, replacement, 'test/integration/api.test.ts');
      assert.strictEqual(weakened, true);
    });

    it('should detect trivializing assertions to always pass', () => {
      const target = "assert.strictEqual(res.value, expected);";
      const replacement = "assert.ok(true);";
      const weakened = CodeRepairEngine.detectTestWeakening(target, replacement, 'test/unit/core.test.ts');
      assert.strictEqual(weakened, true);
    });

    it('should allow legitimate implementation edits in production source files', () => {
      const target = "return user.name;";
      const replacement = "return user?.name ?? 'Guest';";
      const weakened = CodeRepairEngine.detectTestWeakening(target, replacement, 'src/services/user.ts');
      assert.strictEqual(weakened, false);
    });
  });

  describe('Patch Hashing & Oscillation Detection', () => {
    it('should compute consistent hashes for identical patches', () => {
      const hash1 = CodeRepairEngine.hashPatch('foo', 'bar', 'src/a.ts');
      const hash2 = CodeRepairEngine.hashPatch('foo', 'bar', 'src/a.ts');
      const hash3 = CodeRepairEngine.hashPatch('foo', 'baz', 'src/a.ts');

      assert.strictEqual(hash1, hash2);
      assert.notStrictEqual(hash1, hash3);
    });

    it('should identify oscillating patches that match an earlier iteration', () => {
      const patchHashA = CodeRepairEngine.hashPatch('val = 1;', 'val = 2;', 'src/x.ts');
      const patchHashB = CodeRepairEngine.hashPatch('val = 2;', 'val = 3;', 'src/x.ts');

      const history: RepairAttempt[] = [
        { iteration: 1, patchHash: patchHashA, appliedFiles: ['src/x.ts'], success: false },
        { iteration: 2, patchHash: patchHashB, appliedFiles: ['src/x.ts'], success: false }
      ];

      // If iteration 3 tries to apply patch A again, oscillation must be flagged
      const isOscillating = CodeRepairEngine.isOscillating(patchHashA, history);
      assert.strictEqual(isOscillating, true);

      // If iteration 3 tries a novel patch C, it is not oscillating
      const patchHashC = CodeRepairEngine.hashPatch('val = 3;', 'val = 4;', 'src/x.ts');
      assert.strictEqual(CodeRepairEngine.isOscillating(patchHashC, history), false);
    });
  });
});
