import * as assert from 'assert';
import * as vm from 'vm';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, mockClipboardText, MockUri } from '../mocks/vscodeMock';

describe('Deliverable A - Item 2: Code Block UX & Language Mapping Suite', () => {
  beforeEach(() => {
    resetMockState('C:/Projects/test-workspace');
  });

  describe('1. Language Identifier to File Extension Mapping', () => {
    it('should correctly map C# aliases to .cs', () => {
      const csharpVariants = ['csharp', 'cs', 'c#', 'CSHARP', 'CS', 'C#', ' csharp '];
      for (const variant of csharpVariants) {
        assert.strictEqual(
          ChatViewProvider.mapLanguageToExtension(variant),
          'cs',
          `Expected ${variant} to map to 'cs'`
        );
      }
    });

    it('should correctly map TypeScript and JavaScript variants', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('typescript'), 'ts');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('ts'), 'ts');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('tsx'), 'tsx');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('typescriptreact'), 'tsx');

      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('javascript'), 'js');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('js'), 'js');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('jsx'), 'jsx');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('javascriptreact'), 'jsx');
    });

    it('should correctly map Python variants to .py', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('python'), 'py');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('py'), 'py');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('python3'), 'py');
    });

    it('should correctly map Shell and PowerShell scripts', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('bash'), 'sh');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('shell'), 'sh');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('sh'), 'sh');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('zsh'), 'sh');

      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('powershell'), 'ps1');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('pwsh'), 'ps1');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('ps1'), 'ps1');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('batch'), 'bat');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('bat'), 'bat');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('cmd'), 'cmd');
    });

    it('should correctly map Web, Styling and Data languages', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('html'), 'html');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('htm'), 'html');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('css'), 'css');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('scss'), 'scss');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('json'), 'json');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('jsonc'), 'jsonc');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('sql'), 'sql');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('markdown'), 'md');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('md'), 'md');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('yaml'), 'yaml');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('yml'), 'yaml');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('xml'), 'xml');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('dockerfile'), 'dockerfile');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('docker'), 'dockerfile');
    });

    it('should correctly map Systems languages (Rust, Go, Swift, C/C++)', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('rust'), 'rs');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('rs'), 'rs');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('go'), 'go');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('golang'), 'go');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('swift'), 'swift');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('c'), 'c');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('cpp'), 'cpp');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('c++'), 'cpp');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('h'), 'h');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('hpp'), 'hpp');
    });

    it('should fall back to txt for unknown or empty language tags', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension(''), 'txt');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('   '), 'txt');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('unrecognized_format_name'), 'txt');
    });

    it('should strip leading dots from language names', () => {
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('.cs'), 'cs');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('.py'), 'py');
      assert.strictEqual(ChatViewProvider.mapLanguageToExtension('.ts'), 'ts');
    });
  });

  describe('2. Extension to VS Code Language Identifier Mapping', () => {
    it('should map standard extensions back to VS Code language IDs', () => {
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('cs'), 'csharp');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('ts'), 'typescript');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('tsx'), 'typescriptreact');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('js'), 'javascript');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('py'), 'python');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('sh'), 'shellscript');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('ps1'), 'powershell');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('bat'), 'bat');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('cmd'), 'bat');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('swift'), 'swift');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('dockerfile'), 'dockerfile');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('rs'), 'rust');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('go'), 'go');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('sql'), 'sql');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('txt'), 'plaintext');
      assert.strictEqual(ChatViewProvider.mapExtensionToLanguage('unknown'), 'plaintext');
    });
  });

  describe('3. Clipboard Integration & Webview Communication', () => {
    it('should write exact code to clipboard when receiving copyToClipboard message', async () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);

      let messageCallback: ((data: any) => Promise<void>) | undefined;
      const mockWebviewView: any = {
        webview: {
          options: {},
          html: '',
          onDidReceiveMessage: (cb: any) => {
            messageCallback = cb;
            return { dispose: () => {} };
          },
          postMessage: async () => true,
        },
      };

      provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
      assert.ok(messageCallback, 'Message callback should be registered');

      const targetSnippet = 'public class Order { public int Id { get; set; } }';
      await messageCallback!({
        type: 'copyToClipboard',
        text: targetSnippet,
      });

      assert.strictEqual(
        mockClipboardText,
        targetSnippet,
        'Expected clipboard to contain the exact copied code'
      );
    });

    it('should safely ignore copyToClipboard with empty or missing text', async () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);

      let messageCallback: ((data: any) => Promise<void>) | undefined;
      const mockWebviewView: any = {
        webview: {
          options: {},
          html: '',
          onDidReceiveMessage: (cb: any) => {
            messageCallback = cb;
            return { dispose: () => {} };
          },
          postMessage: async () => true,
        },
      };

      provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
      await messageCallback!({ type: 'copyToClipboard', text: '' });
      assert.strictEqual(mockClipboardText, '', 'Clipboard should remain empty');
    });
  });

  describe('4. Webview Client Script Execution & Regression Suite', () => {
    function createWebviewContext() {
      const service = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);
      const html = (provider as any)._getHtmlForWebview({
        asWebviewUri: (uri: any) => uri,
        cspSource: 'https:',
      });

      // Extract client script inside <script>...</script>
      const scriptMatch = html.match(/<script(?:\s+nonce="[^"]*")?>([\s\S]*?)<\/script>/);
      assert.ok(scriptMatch, 'Webview HTML must contain a <script> block');

      const postedMessages: any[] = [];
      const vscodeApi = {
        postMessage: (msg: any) => {
          postedMessages.push(msg);
        }
      };

      const elementMock: any = {
        addEventListener: () => {},
        style: {},
        classList: { add: () => {}, remove: () => {} },
        appendChild: () => {},
        value: '',
        textContent: '',
        scrollTop: 0,
        scrollHeight: 0,
        focus: () => {}
      };

      const sandbox: any = {
        window: {
          addEventListener: () => {}
        },
        document: {
          getElementById: () => elementMock,
          createElement: () => elementMock,
          addEventListener: () => {}
        },
        acquireVsCodeApi: () => vscodeApi,
        vscode: vscodeApi,
        navigator: {
          clipboard: {
            writeText: async (text: string) => {
              sandbox._lastClipboard = text;
            }
          }
        },
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout: (fn: any) => setTimeout(fn, 0)
      };
      sandbox.window.window = sandbox.window;

      vm.createContext(sandbox);
      vm.runInContext(scriptMatch[1], sandbox);

      return {
        sandbox,
        postedMessages,
        renderMarkdown: sandbox.renderMarkdown,
        getLanguageExtension: sandbox.getLanguageExtension,
        html
      };
    }

    it('should generate HTML containing the copy button and language mapping functions', () => {
      const ctx = createWebviewContext();
      assert.ok(ctx.html.includes('copyCode(this,'), 'HTML must contain copyCode button call');
      assert.ok(ctx.html.includes('getLanguageExtension(lang)'), 'HTML must contain getLanguageExtension helper');
      assert.ok(ctx.html.includes('copyToClipboard'), 'HTML must contain copyToClipboard fallback postMessage');
    });

    it('should synchronize language mappings between extension host and webview', () => {
      const ctx = createWebviewContext();
      const testCases = [
        ['batch', 'bat'],
        ['bat', 'bat'],
        ['cmd', 'cmd'],
        ['swift', 'swift'],
        ['dockerfile', 'dockerfile'],
        ['docker', 'dockerfile'],
        ['csharp', 'cs'],
        ['c#', 'cs'],
        ['typescript', 'ts'],
        ['javascript', 'js'],
        ['python', 'py'],
        ['bash', 'sh'],
        ['powershell', 'ps1'],
        ['rust', 'rs'],
        ['go', 'go']
      ];

      for (const [lang, expectedExt] of testCases) {
        const hostExt = ChatViewProvider.mapLanguageToExtension(lang);
        const webviewExt = ctx.getLanguageExtension(lang);
        assert.strictEqual(hostExt, expectedExt, `Host mapping failed for ${lang}`);
        assert.strictEqual(webviewExt, expectedExt, `Webview mapping failed for ${lang}`);
      }
    });

    it('should correctly render incomplete streaming code fence preceded by ordinary text', () => {
      const ctx = createWebviewContext();
      const mockElement = { innerHTML: '' };
      const streamText = 'Here is your code:\n```python\nprint("streaming...")';

      ctx.renderMarkdown(mockElement, streamText);

      // Verify ordinary text before fence is preserved
      assert.ok(mockElement.innerHTML.includes('Here is your code:'), 'Intro text before fence must be rendered');
      // Verify open code block with python language header is rendered
      assert.ok(mockElement.innerHTML.includes('<div class="code-header"><span>python</span>'), 'Language header must be python');
      assert.ok(mockElement.innerHTML.includes('<code>print(&quot;streaming...&quot;)</code>'), 'Code body must be rendered inside code block');
      assert.ok(mockElement.innerHTML.includes('class="code-btn-copy"'), 'Copy button must be present on streaming block');
    });

    it('should correctly render completed code block and preserve trailing text', () => {
      const ctx = createWebviewContext();
      const mockElement = { innerHTML: '' };
      const completedText = 'Intro:\n```typescript\nconst a = 10;\n```\nExplanation follows.';

      ctx.renderMarkdown(mockElement, completedText);

      assert.ok(mockElement.innerHTML.includes('Intro:'), 'Intro text must be rendered');
      assert.ok(mockElement.innerHTML.includes('<div class="code-header"><span>typescript</span>'), 'Language header must be typescript');
      assert.ok(mockElement.innerHTML.includes('const a = 10;'), 'Code content must be rendered');
      assert.ok(mockElement.innerHTML.includes('Explanation follows.'), 'Trailing text must be rendered');
    });

    it('should handle partial opening fences during streaming without crashing or leaking', () => {
      const ctx = createWebviewContext();
      const mockElement = { innerHTML: '' };

      // Case A: Just ```
      ctx.renderMarkdown(mockElement, '```');
      assert.ok(mockElement.innerHTML.includes('<pre><div class="code-header"><span>code</span>'), 'Raw fence should open pre block');

      // Case B: Streamed ```python without newline
      ctx.renderMarkdown(mockElement, '```python');
      assert.ok(mockElement.innerHTML.includes('<div class="code-header"><span>python</span>'), 'Header should display language in progress');

      // Case C: Intro text followed by just ```
      ctx.renderMarkdown(mockElement, 'Generating code now:\n```');
      assert.ok(mockElement.innerHTML.includes('Generating code now:'), 'Intro text must be rendered');
      assert.ok(mockElement.innerHTML.includes('<pre><div class="code-header"><span>code</span>'), 'Fence should open pre block');
    });

    it('should strictly sanitize malicious-looking language identifiers to prevent XSS and DOM breakage', () => {
      const ctx = createWebviewContext();
      const mockElement = { innerHTML: '' };

      // Injection vector 1: breaking out of string literal inside onclick
      const malicious1 = '```js"); alert(1); ("\nconsole.log(1);\n```';
      ctx.renderMarkdown(mockElement, malicious1);
      assert.ok(!mockElement.innerHTML.includes('alert(1)'), 'Script injection must not be rendered');
      assert.ok(mockElement.innerHTML.includes('<span>code</span>'), 'Unsafe language identifier must fall back to code');

      // Injection vector 2: HTML tag injection
      const malicious2 = '```<script>alert("xss")</script>\nfoo();\n```';
      ctx.renderMarkdown(mockElement, malicious2);
      assert.ok(!mockElement.innerHTML.includes('<script>'), 'HTML tag must not be injected');
      assert.ok(mockElement.innerHTML.includes('<span>code</span>'), 'HTML-injected identifier must fall back to code');

      // Injection vector 3: attribute breakout
      const malicious3 = '```python" onclick="alert(1)\nbar();\n```';
      ctx.renderMarkdown(mockElement, malicious3);
      assert.ok(!mockElement.innerHTML.includes('onclick="alert(1)'), 'Attribute breakout must not occur');
      assert.ok(mockElement.innerHTML.includes('<span>code</span>'), 'Attribute-injected identifier must fall back to code');
    });

    it('should preserve Create File functionality with proper filename for standard and docker languages', () => {
      const ctx = createWebviewContext();

      // Test standard file
      ctx.sandbox.window.createFile(encodeURIComponent('print(1)'), encodeURIComponent('python'));
      const createMessages1 = ctx.postedMessages.filter((m: any) => m.type === 'createFile');
      assert.strictEqual(createMessages1.length, 1);
      assert.strictEqual(createMessages1[0].fileName, 'file.py');
      assert.strictEqual(createMessages1[0].code, 'print(1)');

      // Test Dockerfile
      ctx.sandbox.window.createFile(encodeURIComponent('FROM node:18'), encodeURIComponent('dockerfile'));
      const createMessages2 = ctx.postedMessages.filter((m: any) => m.type === 'createFile');
      assert.strictEqual(createMessages2.length, 2);
      assert.strictEqual(createMessages2[1].fileName, 'Dockerfile');

      // Test HTML
      ctx.sandbox.window.createFile(encodeURIComponent('<html></html>'), encodeURIComponent('html'));
      const createMessages3 = ctx.postedMessages.filter((m: any) => m.type === 'createFile');
      assert.strictEqual(createMessages3.length, 3);
      assert.strictEqual(createMessages3[2].fileName, 'index.html');
    });
  });
});
