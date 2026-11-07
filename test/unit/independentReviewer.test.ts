import * as assert from 'assert';
import { IndependentReviewer, ReviewComment } from '../../src/services/independentReviewer';

describe('Phase 9.6: High-Signal Independent Reviewer Pipeline Suite', () => {
  it('should approve clean code patches with passing checks', () => {
    const request = {
      objective: 'Refactor helper to use nullish coalescing',
      patches: [
        {
          filePath: 'src/services/utils.ts',
          target: 'return name || "Anonymous";',
          replacement: 'return name ?? "Anonymous";'
        }
      ]
    };

    const result = IndependentReviewer.reviewPatches(request);
    assert.strictEqual(result.decision, 'APPROVED');
    assert.strictEqual(result.deterministicChecksPassed, true);
    assert.strictEqual(result.blockingErrors.length, 0);
  });

  it('should reject patches introducing compiler diagnostics', () => {
    const request = {
      objective: 'Fix type error',
      patches: [
        {
          filePath: 'src/index.ts',
          target: 'const x = 1;',
          replacement: 'const x: string = 1;'
        }
      ],
      compilerErrors: ["Type 'number' is not assignable to type 'string' in src/index.ts:1"]
    };

    const result = IndependentReviewer.reviewPatches(request);
    assert.strictEqual(result.decision, 'REJECTED');
    assert.strictEqual(result.deterministicChecksPassed, false);
    assert.ok(result.blockingErrors.some(e => e.includes('Compiler error')));
  });

  it('should reject patches targeting sensitive files', () => {
    const request = {
      objective: 'Update settings',
      patches: [
        {
          filePath: '.env',
          target: 'PORT=3000',
          replacement: 'PORT=8080'
        }
      ]
    };

    const result = IndependentReviewer.reviewPatches(request);
    assert.strictEqual(result.decision, 'REJECTED');
    assert.ok(result.blockingErrors.some(e => e.includes('sensitive target')));
  });

  it('should reject patches leaking credentials or private keys', () => {
    const request = {
      objective: 'Add api token',
      patches: [
        {
          filePath: 'src/api.ts',
          target: 'const token = process.env.API_KEY;',
          replacement: 'const token = "sk-abcdef12345678901234567890123456";'
        }
      ]
    };

    const result = IndependentReviewer.reviewPatches(request);
    assert.strictEqual(result.decision, 'REJECTED');
    assert.ok(result.blockingErrors.some(e => e.includes('hardcoded secret')));
  });

  it('should reject patches attempting to skip tests', () => {
    const request = {
      objective: 'Fix failing test',
      patches: [
        {
          filePath: 'test/unit/auth.test.ts',
          target: 'it("logs in", () => {',
          replacement: 'it.skip("logs in", () => {'
        }
      ]
    };

    const result = IndependentReviewer.reviewPatches(request);
    assert.strictEqual(result.decision, 'REJECTED');
    assert.ok(result.blockingErrors.some(e => e.includes('Test weakening')));
  });

  it('should prune hallucinated review comments with out-of-bounds line numbers', () => {
    const comments: ReviewComment[] = [
      { filePath: 'src/a.ts', line: 10, severity: 'warning', message: 'Valid line comment', ruleId: 'R1' },
      { filePath: 'src/a.ts', line: 9999, severity: 'error', message: 'Hallucinated line comment', ruleId: 'R2' },
      { filePath: 'src/a.ts', line: -5, severity: 'error', message: 'Negative line number', ruleId: 'R3' },
      { filePath: 'src/b.ts', severity: 'info', message: 'File-level comment without line', ruleId: 'R4' }
    ];

    const fileLineCounts = {
      'src/a.ts': 100,
      'src/b.ts': 50
    };

    const pruned = IndependentReviewer.pruneHallucinatedComments(comments, fileLineCounts);
    assert.strictEqual(pruned.length, 2);
    assert.strictEqual(pruned[0].message, 'Valid line comment');
    assert.strictEqual(pruned[1].message, 'File-level comment without line');
  });
});
