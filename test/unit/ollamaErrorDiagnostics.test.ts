import * as assert from 'assert';
import { OllamaConnectionError } from '../../src/services/ollamaService';

describe('Deliverable 6 & G: Ollama Diagnostics and Error Suite', () => {
  it('should format connection refused error with clear actionable instruction', () => {
    const err = new OllamaConnectionError({
      errorName: 'TypeError',
      errorMessage: 'fetch failed',
      causeCode: 'ECONNREFUSED',
      causeMessage: 'connect ECONNREFUSED 127.0.0.1:11434',
      endpoint: 'http://127.0.0.1:11434',
      model: 'deepseek-r1:8b',
      numCtx: 16384,
      elapsedMs: 14,
      promptSizeBytes: 420,
      isHttpError: false,
    });

    assert.strictEqual(err.name, 'OllamaConnectionError');
    assert.ok(err.message.includes('Connection Refused'));
    assert.ok(err.message.includes('ollama serve'));
    assert.strictEqual(err.diagnostics.causeCode, 'ECONNREFUSED');
    assert.strictEqual(err.diagnostics.model, 'deepseek-r1:8b');
    assert.strictEqual(err.diagnostics.elapsedMs, 14);
  });

  it('should format HTTP error with status and sanitized body', () => {
    const err = new OllamaConnectionError({
      errorName: 'OllamaHttpError',
      errorMessage: 'Ollama error (400)',
      endpoint: 'http://127.0.0.1:11434',
      model: 'deepseek-r1:8b',
      numCtx: 16384,
      elapsedMs: 250,
      promptSizeBytes: 300,
      isHttpError: true,
      httpStatus: 400,
      httpBody: 'model "deepseek-r1:8b" does not support tools',
    });

    assert.ok(err.message.includes('Ollama HTTP Error (400)'));
    assert.ok(err.message.includes('does not support tools'));
    assert.strictEqual(err.diagnostics.isHttpError, true);
    assert.strictEqual(err.diagnostics.httpStatus, 400);
  });

  it('should format timeout errors with elapsed duration', () => {
    const err = new OllamaConnectionError({
      errorName: 'TypeError',
      errorMessage: 'fetch failed',
      causeCode: 'ETIMEDOUT',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
      elapsedMs: 5002,
      isHttpError: false,
    });

    assert.ok(err.message.includes('timed out after 5002ms'));
    assert.strictEqual(err.diagnostics.causeCode, 'ETIMEDOUT');
  });
});
