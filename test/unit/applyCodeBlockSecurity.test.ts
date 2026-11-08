import * as assert from 'assert';
import { MessageValidator, MessageValidationError } from '../../src/services/messageValidator';

describe('Deliverable 4 & E: Apply to File RPC Security Suite', () => {
  it('should accept valid applyCodeBlock message with messageId and blockIndex', () => {
    const valid = {
      type: 'applyCodeBlock',
      messageId: 'msg-1731000000-abcd1234',
      blockIndex: 0,
    };
    const validated = MessageValidator.validate(valid);
    assert.strictEqual(validated.type, 'applyCodeBlock');
    assert.strictEqual(validated.payload.messageId, 'msg-1731000000-abcd1234');
    assert.strictEqual(validated.payload.blockIndex, 0);
  });

  it('should reject applyCodeBlock with empty or non-string messageId', () => {
    assert.throws(
      () => MessageValidator.validate({ type: 'applyCodeBlock', messageId: '', blockIndex: 0 }),
      MessageValidationError
    );
    assert.throws(
      () => MessageValidator.validate({ type: 'applyCodeBlock', messageId: 12345, blockIndex: 0 }),
      MessageValidationError
    );
  });

  it('should reject applyCodeBlock with negative or non-integer blockIndex', () => {
    assert.throws(
      () => MessageValidator.validate({ type: 'applyCodeBlock', messageId: 'msg-1', blockIndex: -1 }),
      MessageValidationError
    );
    assert.throws(
      () => MessageValidator.validate({ type: 'applyCodeBlock', messageId: 'msg-1', blockIndex: 1.5 }),
      MessageValidationError
    );
  });

  it('should accept switchModeAndRun message', () => {
    const valid = {
      type: 'switchModeAndRun',
      targetMode: 'agent',
      prompt: 'fix the issues',
    };
    const validated = MessageValidator.validate(valid);
    assert.strictEqual(validated.type, 'switchModeAndRun');
    assert.strictEqual(validated.payload.targetMode, 'agent');
    assert.strictEqual(validated.payload.prompt, 'fix the issues');
  });

  it('should accept enableEmbeddedFallback message with optional model', () => {
    const valid = {
      type: 'enableEmbeddedFallback',
      model: 'qwen2.5-coder:7b',
    };
    const validated = MessageValidator.validate(valid);
    assert.strictEqual(validated.type, 'enableEmbeddedFallback');
    assert.strictEqual(validated.payload.model, 'qwen2.5-coder:7b');
  });

  it('should accept enableEmbeddedFallback message without model', () => {
    const valid = {
      type: 'enableEmbeddedFallback',
    };
    const validated = MessageValidator.validate(valid);
    assert.strictEqual(validated.type, 'enableEmbeddedFallback');
    assert.strictEqual(validated.payload.model, undefined);
  });
});
