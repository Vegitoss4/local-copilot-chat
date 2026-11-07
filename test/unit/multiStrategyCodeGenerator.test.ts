import * as assert from 'assert';
import { MultiStrategyCodeGenerator } from '../../src/services/multiStrategyCodeGenerator';

describe('Phase 10.8: Multi-Strategy Code Generation Fallbacks Suite', () => {
  it('should apply patch via Tier 1 (exact_str_replace) when exact match is present', () => {
    const original = 'function add(a, b) {\n  return a + b;\n}';
    const target = 'return a + b;';
    const replacement = 'return Number(a) + Number(b);';

    const res = MultiStrategyCodeGenerator.applyPatch(original, target, replacement);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.tierUsed, 'exact_str_replace');
    assert.ok(res.content.includes('Number(a) + Number(b)'));
  });

  it('should fall back to Tier 2 (normalized_whitespace) when newline formatting or trailing spaces differ', () => {
    // Original has CRLF newlines and trailing space
    const original = 'function foo() {\r\n  const x = 1; \r\n  return x;\r\n}';
    // Target has LF newlines without the trailing space
    const target = 'function foo() {\n  const x = 1;\n  return x;\n}';
    const replacement = 'function foo() {\n  const x = 2;\n  return x;\n}';

    const res = MultiStrategyCodeGenerator.applyPatch(original, target, replacement);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.tierUsed, 'normalized_whitespace');
    assert.ok(res.content.includes('const x = 2;'));
  });

  it('should fall back to Tier 3 (anchor_block_replace) when internal whitespace is re-flowed', () => {
    const original = `
      class UserProfile {
        public render() {
          const name = this.getName();
          const avatar = this.getAvatar();
          return \`<div>\${name}</div>\`;
        }
      }
    `;

    // Target has first and last anchor line but slightly different inner formatting
    const target = `
      public render() {
        // slightly changed comment
        return \`<div>\${name}</div>\`;
    `;
    const replacement = `
        public render() {
          return <span>User</span>;
        }
    `;

    const res = MultiStrategyCodeGenerator.applyPatch(original, target, replacement);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.tierUsed, 'anchor_block_replace');
    assert.ok(res.content.includes('<span>User</span>'));
  });

  it('should fail gracefully and preserve original content if no strategy succeeds', () => {
    const original = 'const a = 1;';
    const nonExistentTarget = 'const nonExistent = 999;';

    const res = MultiStrategyCodeGenerator.applyPatch(original, nonExistentTarget, 'replacement');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.content, original);
    assert.ok(res.error?.includes('All 3 patch strategies failed'));
  });
});
