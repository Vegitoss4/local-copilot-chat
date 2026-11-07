import * as assert from 'assert';
import { MessageValidator, MessageValidationError } from '../../src/services/messageValidator';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, MockUri } from '../mocks/vscodeMock';

describe('Phase 1.3 & 1.4: Webview CSP, Message Contracts & RPC Validation Suite', () => {
  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
  });

  describe('1. Webview Content Security Policy (CSP)', () => {
    it('should include strict Content-Security-Policy meta tag restricting default-src to none', () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      const mockWebview = {
        asWebviewUri: (uri: any) => uri,
        cspSource: 'vscode-webview:',
      };

      const html = (provider as any)._getHtmlForWebview(mockWebview);

      assert.ok(html.includes('<meta http-equiv="Content-Security-Policy"'), 'HTML must include CSP meta tag');
      assert.ok(html.includes("default-src 'none'"), 'CSP must restrict default-src to none');
      assert.ok(html.includes("img-src vscode-webview: https: data:;"), 'CSP must restrict img-src');
      assert.ok(html.includes("font-src vscode-webview:;"), 'CSP must restrict font-src');
    });

    it('should enforce cryptographically secure nonce on script-src without unsafe-inline', () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      const mockWebview = {
        asWebviewUri: (uri: any) => uri,
        cspSource: 'vscode-webview:',
      };

      const html1 = (provider as any)._getHtmlForWebview(mockWebview);
      const html2 = (provider as any)._getHtmlForWebview(mockWebview);

      const nonceMatch1 = html1.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/);
      assert.ok(nonceMatch1, 'CSP must specify script-src with a nonce');
      assert.ok(nonceMatch1[1].length >= 16, 'Nonce must have sufficient cryptographic entropy');
      assert.ok(!html1.includes("script-src 'unsafe-inline'"), "CSP must NOT allow unsafe-inline in script-src");
      assert.ok(!html1.includes("script-src vscode-webview: 'unsafe-inline'"), "CSP must NOT allow unsafe-inline for webview");

      const nonceMatch2 = html2.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/);
      assert.ok(nonceMatch2, 'Second render must specify script-src with a nonce');
      assert.notStrictEqual(nonceMatch1[1], nonceMatch2[1], 'Each render must generate a fresh unique nonce');

      // Check script tag uses the nonce
      assert.ok(html1.includes(`<script nonce="${nonceMatch1[1]}">`), 'Client script tag must match CSP nonce');
      assert.ok(!html1.includes('onclick='), 'HTML must contain zero inline onclick handlers');
    });
  });

  describe('2. MessageValidator Contract & Payload Validation', () => {
    it('should reject non-object or null messages', () => {
      const invalidPayloads = [null, undefined, 'hello', 123, true, []];
      for (const payload of invalidPayloads) {
        assert.throws(
          () => MessageValidator.validate(payload),
          (err: any) => err instanceof MessageValidationError && err.message.includes('must be an object')
        );
      }
    });

    it('should reject missing or empty message type', () => {
      assert.throws(
        () => MessageValidator.validate({}),
        (err: any) => err instanceof MessageValidationError && err.message.includes("'type'")
      );
      assert.throws(
        () => MessageValidator.validate({ type: '   ' }),
        (err: any) => err instanceof MessageValidationError && err.message.includes("'type'")
      );
    });

    it('should reject unauthorized or unexpected message types', () => {
      const maliciousTypes = ['executeRaw', 'eval', 'downloadFile', 'openSocket', 'adminCommand'];
      for (const badType of maliciousTypes) {
        assert.throws(
          () => MessageValidator.validate({ type: badType }),
          (err: any) => err instanceof MessageValidationError && err.message.includes('Unauthorized message type')
        );
      }
    });

    it('should validate and sanitize valid sendMessage messages', () => {
      const raw = {
        type: 'sendMessage',
        text: 'Fix bug in auth.ts',
        mode: 'agent',
        model: 'qwen2.5-coder:7b',
        autonomousMode: true,
      };
      const validated = MessageValidator.validate(raw);

      assert.strictEqual(validated.type, 'sendMessage');
      assert.strictEqual(validated.payload.text, 'Fix bug in auth.ts');
      assert.strictEqual(validated.payload.mode, 'agent');
      assert.strictEqual(validated.payload.model, 'qwen2.5-coder:7b');
      assert.strictEqual(validated.payload.autonomousMode, true);
    });

    it('should reject sendMessage with missing or empty text', () => {
      assert.throws(
        () => MessageValidator.validate({ type: 'sendMessage', text: '' }),
        (err: any) => err instanceof MessageValidationError && err.message.includes("'text'")
      );
      assert.throws(
        () => MessageValidator.validate({ type: 'sendMessage', text: 12345 }),
        (err: any) => err instanceof MessageValidationError && err.message.includes("'text'")
      );
    });

    it('should validate insertCode and createFile payloads', () => {
      const insertMsg = MessageValidator.validate({ type: 'insertCode', code: 'const x = 1;' });
      assert.strictEqual(insertMsg.payload.code, 'const x = 1;');

      const createMsg = MessageValidator.validate({
        type: 'createFile',
        fileName: 'utils.ts',
        code: 'export const add = (a, b) => a + b;',
      });
      assert.strictEqual(createMsg.payload.fileName, 'utils.ts');
      assert.strictEqual(createMsg.payload.code, 'export const add = (a, b) => a + b;');
    });

    it('should reject createFile with missing fileName or non-string code', () => {
      assert.throws(
        () => MessageValidator.validate({ type: 'createFile', fileName: '   ', code: 'code' }),
        (err: any) => err instanceof MessageValidationError && err.message.includes('fileName')
      );
      assert.throws(
        () => MessageValidator.validate({ type: 'createFile', fileName: 'file.ts', code: null }),
        (err: any) => err instanceof MessageValidationError && err.message.includes('code')
      );
    });

    it('should reject prohibited Tier 4 commands in runCommand messages', () => {
      const prohibitedCommands = ['rm -rf /', 'format C:', 'cmd.exe', 'powershell.exe -enc ...', 'del /f test.txt'];
      for (const cmd of prohibitedCommands) {
        assert.throws(
          () => MessageValidator.validate({ type: 'runCommand', command: cmd }),
          (err: any) => err instanceof MessageValidationError && err.message.includes('prohibited')
        );
      }
    });

    it('should accept valid commands in runCommand messages', () => {
      const validated = MessageValidator.validate({ type: 'runCommand', command: 'git status' });
      assert.strictEqual(validated.payload.command, 'git status');
    });
  });

  describe('3. ChatViewProvider onDidReceiveMessage RPC Security Guard', () => {
    it('should post rpcError when receiving a malformed or unauthorized message', async () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);

      const postedMessages: any[] = [];
      let messageHandler: ((data: any) => Promise<void>) | undefined;

      const mockWebview = {
        options: {},
        html: '',
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
          return { dispose: () => {} };
        },
        postMessage: async (msg: any) => {
          postedMessages.push(msg);
        },
      };

      provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

      assert.ok(messageHandler, 'Message handler should be registered');

      // Send unauthorized message type
      await messageHandler({ type: 'arbitraryExploit', payload: 'malicious' });

      const errPost = postedMessages.find((m) => m.type === 'rpcError');
      assert.ok(errPost, 'Provider must post rpcError when message is unauthorized');
      assert.ok(errPost.error.includes('Unauthorized message type'));
    });
  });

  describe('4. Phase 5.5 H2: Webview CSP, Zero Inline Handlers & XSS Neutralization Suite', () => {
    it('should verify HTML contains strictly zero inline on* attribute handlers', () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      const mockWebview = {
        asWebviewUri: (uri: any) => uri,
        cspSource: 'vscode-webview:',
      };

      const html = (provider as any)._getHtmlForWebview(mockWebview);

      // Search for any inline on<event>= attributes e.g. onclick=, onload=, onerror=
      const inlineHandlerPattern = /\s+on[a-zA-Z]+\s*=/g;
      const matches = html.match(inlineHandlerPattern);
      assert.strictEqual(
        matches,
        null,
        `Found forbidden inline event handler attributes: ${JSON.stringify(matches)}`
      );
    });

    it('should verify CSP contains no unsafe-inline or unsafe-eval in script-src', () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      const mockWebview = {
        asWebviewUri: (uri: any) => uri,
        cspSource: 'vscode-webview:',
      };

      const html = (provider as any)._getHtmlForWebview(mockWebview);
      const scriptSrcMatch = html.match(/script-src\s+([^;]+);/);
      assert.ok(scriptSrcMatch, 'script-src directive must be present in CSP');
      const scriptSrc = scriptSrcMatch[1];
      assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src must not contain 'unsafe-inline'");
      assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src must not contain 'unsafe-eval'");
      assert.ok(scriptSrc.includes("'nonce-"), "script-src must require a nonce");
    });

    it('should verify escapeHtml neutralizing malicious XSS payload corpus', () => {
      const escapeHtml = (text: any): string => {
        if (!text) return '';
        return String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const maliciousPayloads = [
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(\'xss\')">',
        '<svg onload=alert(1)>',
        '"><script>document.cookie</script>',
        "';alert(1);//",
        '<a href="javascript:alert(1)">Click</a>',
      ];

      for (const payload of maliciousPayloads) {
        const escaped = escapeHtml(payload);
        assert.ok(!escaped.includes('<script>'), `Failed to escape script tags in: ${payload}`);
        assert.ok(!escaped.includes('<img'), `Failed to escape img tags in: ${payload}`);
        assert.ok(!escaped.includes('<svg'), `Failed to escape svg tags in: ${payload}`);
        assert.ok(!escaped.includes('"'), `Failed to escape double quotes in: ${payload}`);
        assert.ok(!escaped.includes("'"), `Failed to escape single quotes in: ${payload}`);
      }
    });
  });
});
