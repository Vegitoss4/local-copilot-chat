import * as assert from 'assert';
import {
  ContextCompactionService,
  CompactionResult,
  FidelityEvaluationResult
} from '../../src/services/contextCompactionService';
import { ChatMessage } from '../../src/services/ollamaService';

describe('Deliverable 11.3: Intelligent Tiered Context Compaction & Fidelity Harness Suite', () => {
  describe('Tier 1: Lossless Deduplication & Output Truncation', () => {
    it('should replace superseded earlier file reads with pointers while keeping latest read intact', () => {
      const longContent = 'export class OldContent {\n' + '  // line\n'.repeat(40) + '}';
      const newContent = 'export class NewContent {\n' + '  // line\n'.repeat(40) + '}';

      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: `Here is the file:\nFile Content: \`src/models/user.ts\`\n\`\`\`typescript\n${longContent}\n\`\`\``
        },
        { role: 'user', content: 'Now please update the email property' },
        {
          role: 'assistant',
          content: `Updated file:\nFile Content: \`src/models/user.ts\`\n\`\`\`typescript\n${newContent}\n\`\`\``
        }
      ];

      const deduped = ContextCompactionService.applyTier1LosslessDeduplication(messages);

      assert.strictEqual(deduped.length, 3);
      // Older read at index 0 should be pruned
      assert.ok(deduped[0].content.includes('[Superseded: Earlier read of "src/models/user.ts"'));
      assert.ok(!deduped[0].content.includes('OldContent'));

      // Latest read at index 2 should be preserved in full
      assert.ok(deduped[2].content.includes('NewContent'));
    });

    it('should truncate excessively long command outputs preserving head and tail', () => {
      const manyLines = Array.from({ length: 60 }, (_, i) => `Log line ${i + 1}: processing item`).join('\n');
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Run test suite' },
        { role: 'tool', content: `stdout:\n\`\`\`\n${manyLines}\n\`\`\`` }
      ];

      const deduped = ContextCompactionService.applyTier1LosslessDeduplication(messages);

      assert.strictEqual(deduped.length, 2);
      const toolOutput = deduped[1].content;

      assert.ok(toolOutput.includes('Log line 1'));
      assert.ok(toolOutput.includes('Log line 5'));
      assert.ok(toolOutput.includes('lines of command output truncated'));
      assert.ok(toolOutput.includes('Log line 60'));
      assert.ok(!toolOutput.includes('Log line 30'));
    });
  });

  describe('Tier 2: Structured Pruning', () => {
    it('should compress verbose successful tool outputs into compact summary signatures', () => {
      const verboseToolResult = 'OK\n' + 'line\n'.repeat(100);
      const messages: ChatMessage[] = [
        { role: 'tool', content: verboseToolResult }
      ];

      const pruned = ContextCompactionService.applyTier2StructuredPruning(messages);

      assert.strictEqual(pruned.length, 1);
      assert.ok(pruned[0].content.startsWith('[Tool Result:'));
      assert.ok(pruned[0].content.includes('(output compacted)'));
    });
  });

  describe('Tiered Compaction Pipeline & Token Budgets', () => {
    it('should return uncompacted messages when total tokens are well within budget', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' }
      ];

      const result = ContextCompactionService.compactTiered(messages, { maxContextTokens: 1000 });
      assert.strictEqual(result.wasCompacted, false);
      assert.strictEqual(result.messages.length, 2);
    });

    it('should execute tiered compaction when token budget is exceeded and preserve recent turns', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an assistant.' },
        { role: 'user', content: 'Goal: refactor database models in src/db.ts' },
        { role: 'assistant', content: 'Inspecting src/db.ts...\n' + 'data '.repeat(400) },
        { role: 'user', content: 'Check build now' },
        { role: 'assistant', content: 'Ran checkBuild, build succeeded.' },
        { role: 'user', content: 'Great, now let us write tests' },
        { role: 'assistant', content: 'Creating test/db.test.ts...' }
      ];

      const result = ContextCompactionService.compactTiered(messages, {
        maxContextTokens: 300,
        preserveRecentMessages: 2
      });

      assert.strictEqual(result.wasCompacted, true);
      assert.ok(result.estimatedTokensAfter < result.estimatedTokensBefore);
      assert.ok(result.messages.length < messages.length);

      // Verify the recent 2 messages are preserved exactly
      const lastMsg = result.messages[result.messages.length - 1];
      assert.strictEqual(lastMsg.content, 'Creating test/db.test.ts...');
    });
  });

  describe('Compaction Fidelity Verification Harness', () => {
    it('should measure needle retention rate accurately across compacted conversation', () => {
      const compactedMessages: ChatMessage[] = [
        {
          role: 'system',
          content: '### Prior Conversation Summary\n- Original User Goal: Refactor Auth0 SSO\n- Files Modified: src/auth.ts, src/config.ts'
        },
        { role: 'user', content: 'Now test with client_id=12345' },
        { role: 'assistant', content: 'Updated authentication token handler.' }
      ];

      const needles = [
        'Auth0 SSO',
        'src/auth.ts',
        'client_id=12345',
        'missing_secret_key' // intentional missing needle
      ];

      const fidelity: FidelityEvaluationResult = ContextCompactionService.evaluateCompactionFidelity(
        compactedMessages,
        needles
      );

      assert.strictEqual(fidelity.totalNeedles, 4);
      assert.strictEqual(fidelity.foundNeedles.length, 3);
      assert.strictEqual(fidelity.missingNeedles.length, 1);
      assert.strictEqual(fidelity.missingNeedles[0], 'missing_secret_key');
      assert.strictEqual(fidelity.retentionRate, 0.75);
    });

    it('should achieve 100% retention when all critical needles are preserved in summary', () => {
      const compactedMessages: ChatMessage[] = [
        {
          role: 'system',
          content: 'User goal: fix bug. Target: src/api.ts. Constraint: zero breaking changes.'
        }
      ];

      const needles = ['fix bug', 'src/api.ts', 'zero breaking changes'];
      const fidelity = ContextCompactionService.evaluateCompactionFidelity(compactedMessages, needles);

      assert.strictEqual(fidelity.retentionRate, 1.0);
      assert.strictEqual(fidelity.missingNeedles.length, 0);
    });
  });
});
