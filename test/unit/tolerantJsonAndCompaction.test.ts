import * as assert from 'assert';
import { TolerantJsonParser } from '../../src/services/tolerantJsonParser';
import { ContextCompactionService } from '../../src/services/contextCompactionService';
import { ChatMessage } from '../../src/services/ollamaService';

describe('Phase 9.7: Tolerant JSON Parser & Context Compaction Suite', () => {
  describe('TolerantJsonParser', () => {
    it('should parse valid JSON directly without modifications', () => {
      const input = '{"name": "test", "count": 42, "items": [1, 2, 3]}';
      const result = TolerantJsonParser.parse(input);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.wasRepaired, false);
      assert.strictEqual(result.repairTechnique, 'none');
      assert.deepStrictEqual(result.data, { name: 'test', count: 42, items: [1, 2, 3] });
    });

    it('should strip markdown code fences with json tag and trailing text', () => {
      const input = 'Here is the plan:\n```json\n{"step": 1, "action": "test"}\n```\nHope this helps!';
      const result = TolerantJsonParser.parse(input);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.wasRepaired, true);
      assert.strictEqual(result.data?.step, 1);
      assert.strictEqual(result.data?.action, 'test');
    });

    it('should repair trailing commas before closing braces and brackets', () => {
      const input = '{\n  "tool": "patchFile",\n  "files": [\n    "src/index.ts",\n    "src/util.ts",\n  ],\n  "dryRun": false,\n}';
      const result = TolerantJsonParser.parse(input);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.wasRepaired, true);
      assert.strictEqual(result.data?.tool, 'patchFile');
      assert.strictEqual(result.data?.files.length, 2);
      assert.strictEqual(result.data?.dryRun, false);
    });

    it('should repair unquoted keys and single quoted strings', () => {
      const input = "{ tool: 'readFile', args: { path: 'src/main.ts' } }";
      const result = TolerantJsonParser.parse(input);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.wasRepaired, true);
      assert.strictEqual(result.data?.tool, 'readFile');
      assert.strictEqual(result.data?.args?.path, 'src/main.ts');
    });

    it('should balance truncated JSON with unclosed arrays, objects, and strings', () => {
      const input = '{"plan": [{"id": "1", "description": "Analyzing code';
      const result = TolerantJsonParser.parse(input);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.wasRepaired, true);
      assert.strictEqual(result.repairTechnique, 'bracket_balance');
      assert.ok(Array.isArray(result.data?.plan));
      assert.strictEqual(result.data?.plan[0]?.id, '1');
    });

    it('should return error for completely non-JSON text', () => {
      const input = 'This is just a sentence with no JSON at all.';
      const result = TolerantJsonParser.parse(input);
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  describe('ContextCompactionService', () => {
    it('should estimate token counts accurately using character heuristic', () => {
      const tokens = ContextCompactionService.estimateTokens('1234567890123456'); // 16 chars -> 4 tokens
      assert.strictEqual(tokens, 4);
    });

    it('should not compact messages when total tokens are below budget', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' }
      ];

      const res = ContextCompactionService.compactIfNeeded(messages, { maxContextTokens: 1000 });
      assert.strictEqual(res.wasCompacted, false);
      assert.strictEqual(res.messages.length, 3);
    });

    it('should compact older turns into a structured summary when budget is exceeded', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an AI coding assistant.' },
        { role: 'user', content: 'We need to fix the bug in src/services/auth.ts where tokens expire early.' },
        { role: 'assistant', content: 'I will analyze src/services/auth.ts and run tests.' },
        { role: 'user', content: 'Also look at src/services/token.ts for expiration logic.' },
        { role: 'assistant', content: 'Error: Cannot read property exp of undefined in token.ts:42' },
        { role: 'user', content: 'What was the exact line number?' },
        { role: 'assistant', content: 'It was line 42.' },
        { role: 'user', content: 'Please patch it.' },
        { role: 'assistant', content: 'Here is the patch for token.ts' }
      ];

      // Force compaction by setting a low token budget (e.g., 50 tokens)
      const res = ContextCompactionService.compactIfNeeded(messages, {
        maxContextTokens: 50,
        preserveRecentMessages: 4
      });

      assert.strictEqual(res.wasCompacted, true);
      assert.ok(res.messagesCompactedCount > 0);

      // Should have: System message + Summary message + 4 recent messages = 6 total
      assert.strictEqual(res.messages.length, 6);
      assert.strictEqual(res.messages[0].role, 'system');
      assert.strictEqual(res.messages[1].role, 'system');
      assert.ok(res.messages[1].content.includes('<CONTEXT_SUMMARY>'));
      assert.ok(res.messages[1].content.includes('src/services/auth.ts') || res.messages[1].content.includes('token.ts'));
      assert.ok(res.messages[1].content.includes('tokens expire early'));

      // Check that recent 4 messages are untouched
      assert.strictEqual(res.messages[2].content, 'What was the exact line number?');
      assert.strictEqual(res.messages[3].content, 'It was line 42.');
      assert.strictEqual(res.messages[4].content, 'Please patch it.');
      assert.strictEqual(res.messages[5].content, 'Here is the patch for token.ts');
    });
  });
});
