import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { CommandClassifier, CommandTier, CommandSyntaxError } from '../../src/services/commandClassifier';
import { PathSecurity, WorkspaceSecurityError } from '../../src/services/pathSecurity';
import { MessageValidator, MessageValidationError } from '../../src/services/messageValidator';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Phase 8.3: Property-Based Fuzz Testing Suite (fast-check)', function () {
  this.timeout(15000);

  beforeEach(() => {
    resetMockState('C:/Projects/fuzz-workspace');
    setMockWorkspaceFolders([
      { name: 'fuzz-workspace', uri: MockUri.file('C:/Projects/fuzz-workspace'), index: 0 }
    ]);
  });

  describe('1. CommandClassifier Fuzzing & Invariants', () => {
    it('should never throw unhandled runtime errors on arbitrary string inputs (fail-safe parsing)', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 500 }), (cmd) => {
          try {
            const res = CommandClassifier.classify(cmd);
            assert.ok(typeof res.tier === 'number');
            assert.ok(res.tier >= 1 && res.tier <= 4);
          } catch (err: any) {
            // Only CommandSyntaxError is an acceptable rejection
            assert.ok(
              err instanceof CommandSyntaxError,
              `Unexpected error thrown for input "${cmd}": ${err?.name} - ${err?.message}`
            );
          }
        }),
        { numRuns: 200 }
      );
    });

    it('should be strictly deterministic for any input', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (cmd) => {
          let tier1: number | string = 'error';
          let tier2: number | string = 'error';

          try {
            tier1 = CommandClassifier.classify(cmd).tier;
          } catch (e: any) {
            tier1 = e?.name;
          }

          try {
            tier2 = CommandClassifier.classify(cmd).tier;
          } catch (e: any) {
            tier2 = e?.name;
          }

          assert.strictEqual(tier1, tier2, `Nondeterministic classification for: ${cmd}`);
        }),
        { numRuns: 100 }
      );
    });

    it('should never classify shell metacharacter injections as Tier 1 Safe', () => {
      const metachars = [';', '&&', '||', '|', '>', '<', '`', '$(whoami)', '\n', '\r', '\0'];

      fc.assert(
        fc.property(
          fc.constantFrom(...metachars),
          fc.string({ maxLength: 50 }),
          fc.string({ maxLength: 50 }),
          (meta, prefix, suffix) => {
            const injected = `${prefix}${meta}${suffix}`;
            try {
              const res = CommandClassifier.classify(injected);
              assert.notStrictEqual(
                res.tier,
                CommandTier.TIER_1_SAFE_READONLY,
                `Metacharacter "${meta}" injection was dangerously classified as Tier 1: ${injected}`
              );
            } catch (err: any) {
              assert.ok(err instanceof CommandSyntaxError);
            }
          }
        ),
        { numRuns: 150 }
      );
    });
  });

  describe('2. PathSecurity Fuzzing & Invariants', () => {
    it('should reject all paths containing null bytes', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 50 }),
          fc.string({ maxLength: 50 }),
          (prefix, suffix) => {
            const nullPath = `${prefix}\0${suffix}`;
            assert.throws(
              () => PathSecurity.validatePath(nullPath),
              (err: any) => err instanceof WorkspaceSecurityError
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should reject all directory traversal attempts (..)', () => {
      const traversals = ['../', '..\\', '/../', '\\..\\', 'a/../../b', '..'];

      fc.assert(
        fc.property(
          fc.constantFrom(...traversals),
          fc.string({ maxLength: 30 }),
          (trav, rest) => {
            const travPath = `${trav}${rest}`;
            assert.throws(
              () => PathSecurity.validatePath(travPath),
              (err: any) => err instanceof WorkspaceSecurityError
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should reject all UNC path inputs', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 50 }), (target) => {
          const unc = `\\\\server\\share\\${target}`;
          assert.throws(
            () => PathSecurity.validatePath(unc),
            (err: any) => err instanceof WorkspaceSecurityError
          );
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('3. MessageValidator Fuzzing & Invariants', () => {
    it('should never crash on arbitrary randomized payload objects', () => {
      fc.assert(
        fc.property(fc.anything(), (payload) => {
          try {
            const validated = MessageValidator.validate(payload);
            assert.ok(typeof validated.type === 'string');
          } catch (err: any) {
            assert.ok(
              err instanceof MessageValidationError,
              `Unexpected error thrown for payload: ${err?.name} - ${err?.message}`
            );
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});
