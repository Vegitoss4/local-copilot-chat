import * as assert from 'assert';
import { ExtensionLogger } from '../../src/services/extensionLogger';

describe('Phase 8.9: ExtensionLogger Structured Observability & Secret Redaction Suite', () => {
  it('should redact Bearer and Basic tokens from log strings', () => {
    const raw = 'Authorization failed for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz and Basic dXNlcjpwYXNz';
    const redacted = ExtensionLogger.redact(raw);
    assert.strictEqual(redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false);
    assert.strictEqual(redacted.includes('dXNlcjpwYXNz'), false);
    assert.ok(redacted.includes('Bearer [REDACTED]'));
    assert.ok(redacted.includes('Basic [REDACTED]'));
  });

  it('should redact well-known API keys (OpenAI, GitHub, AWS)', () => {
    const sample = 'Using OpenAI key sk-abcdef1234567890abcdef12345 and GitHub token ghp_1234567890abcdef1234567890abcdef12 and AWS AKIAIOSFODNN7EXAMPLE';
    const redacted = ExtensionLogger.redact(sample);
    assert.strictEqual(redacted.includes('sk-abcdef1234567890abcdef12345'), false);
    assert.strictEqual(redacted.includes('ghp_1234567890abcdef1234567890abcdef12'), false);
    assert.strictEqual(redacted.includes('AKIAIOSFODNN7EXAMPLE'), false);
    assert.ok(redacted.includes('[REDACTED]'));
  });

  it('should redact key-value secret and password assignments', () => {
    const text = 'config: password="my_super_secret_password_123" and api_key: "sec_99998888" and token=abc123456789';
    const redacted = ExtensionLogger.redact(text);
    assert.strictEqual(redacted.includes('my_super_secret_password_123'), false);
    assert.strictEqual(redacted.includes('sec_99998888'), false);
    assert.strictEqual(redacted.includes('abc123456789'), false);
    assert.ok(redacted.includes('password="[REDACTED]"') || redacted.includes('password=[REDACTED]'));
  });

  it('should correctly redact value when secret matches the key name prefix (preventing key name replacement)', () => {
    const text = 'config: secret="secret_val" and token: "token_token" and password: "password"';
    const redacted = ExtensionLogger.redact(text);
    assert.strictEqual(redacted.includes('secret_val'), false);
    assert.strictEqual(redacted.includes('token_token'), false);
    assert.ok(redacted.includes('secret: "[REDACTED]"') || redacted.includes('secret="[REDACTED]"'));
    assert.ok(redacted.includes('token: "[REDACTED]"') || redacted.includes('token="[REDACTED]"'));
    assert.ok(redacted.includes('password: "[REDACTED]"') || redacted.includes('password="[REDACTED]"'));
  });

  it('should output structured lines with generation and turn IDs', () => {
    const outputLines: string[] = [];
    const mockChannel: any = {
      appendLine: (line: string) => outputLines.push(line),
    };

    const logger = new ExtensionLogger(mockChannel);
    logger.info('Generation started for user prompt', {
      component: 'ChatProvider',
      genId: 'gen-42',
      turnId: 'turn-1'
    });

    assert.strictEqual(outputLines.length, 1);
    const line = outputLines[0];
    assert.ok(line.includes('[INFO]'));
    assert.ok(line.includes('[ChatProvider Gen:gen-42 Turn:turn-1]'));
    assert.ok(line.includes('Generation started for user prompt'));
  });

  it('should handle Error instances in logger.error with redaction', () => {
    const outputLines: string[] = [];
    const mockChannel: any = {
      appendLine: (line: string) => outputLines.push(line),
    };

    const logger = new ExtensionLogger(mockChannel);
    const err = new Error('Database connection failed with password=supersecretpass');
    logger.error(err, { component: 'Database' });

    assert.strictEqual(outputLines.length, 1);
    const line = outputLines[0];
    assert.ok(line.includes('[ERROR]'));
    assert.ok(line.includes('[Database]'));
    assert.strictEqual(line.includes('supersecretpass'), false);
    assert.ok(line.includes('[REDACTED]'));
  });
});
