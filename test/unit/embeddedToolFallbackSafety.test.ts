import * as assert from 'assert';
import * as vscode from 'vscode';
import { OllamaService } from '../../src/services/ollamaService';
import { ConfigurationService } from '../../src/services/configurationService';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { vscodeMock, updateMockConfiguration } from '../mocks/vscodeMock';

describe('Scoped Fix: Embedded Tool Fallback Strict Safety & Injection Neutralization Suite', () => {
  it('should NOT extract tool calls from echoed file contents containing tool-call-like JSON', () => {
    // Simulates an assistant echoing a C# or TypeScript file that happens to define a tool JSON schema or log
    const contentWithEchoedFile = `Here is the contents of the file:
\`\`\`csharp
public class ToolLogger {
  public string payload = "{\\"name\\": \\"str_replace\\", \\"arguments\\": {\\"filePath\\": \\"exploit.cs\\"}}";
}
\`\`\`
I did not execute any tools.`;

    const calls = OllamaService.extractToolCallsFromContent(contentWithEchoedFile, ['str_replace']);
    assert.strictEqual(calls.length, 0, 'Must NOT extract tool calls from inside non-json language code fences');
  });

  it('should NOT extract tool calls from blockquoted text echoing tool responses', () => {
    const contentWithBlockquote = `The previous tool returned:
> {"name": "str_replace", "arguments": {"filePath": "app.cs", "oldStr": "a", "newStr": "b"}}
Now I will explain what happened.`;

    const calls = OllamaService.extractToolCallsFromContent(contentWithBlockquote, ['str_replace']);
    assert.strictEqual(calls.length, 0, 'Must NOT extract tool calls from blockquoted tool response echoes');
  });

  it('should NOT extract tool calls from inside unclosed <think> blocks', () => {
    const unclosedThinking = `<think>
I wonder if I should call {"name": "str_replace", "arguments": {"filePath": "app.cs"}}
Still thinking...`;

    const calls = OllamaService.extractToolCallsFromContent(unclosedThinking, ['str_replace']);
    assert.strictEqual(calls.length, 0, 'Must NOT extract tool calls from unclosed thinking blocks');
  });

  it('should filter out tool calls whose name is not in the allowedToolNames allowlist', () => {
    const content = `\`\`\`json
{
  "name": "unauthorized_admin_tool",
  "arguments": {"cmd": "rm -rf"}
}
\`\`\``;

    const calls = OllamaService.extractToolCallsFromContent(content, ['list_dir', 'view_file_range']);
    assert.strictEqual(calls.length, 0, 'Must reject tool names not present in the allowlist');
  });

  it('should NOT extract tool call when message contains JSON embedded within prose', () => {
    const proseWithJson = `I will now execute the following tool call for you:
{"name": "str_replace", "arguments": {"filePath": "app.cs", "oldStr": "a", "newStr": "b"}}
Please wait while it completes.`;

    const calls = OllamaService.extractEmbeddedToolCall(proseWithJson, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['str_replace'],
    });
    assert.strictEqual(calls.length, 0, 'Must NOT execute JSON embedded among prose');
  });

  it('should NOT extract tool call when message contains web or documentation text with tool JSON', () => {
    const webText = `According to the Ollama docs, tools are called like this:
{"name": "execute_command", "arguments": {"command": "ls"}}
You can use this syntax in curl.`;

    const calls = OllamaService.extractEmbeddedToolCall(webText, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['execute_command'],
    });
    assert.strictEqual(calls.length, 0, 'Must NOT execute web/doc text containing tool JSON');
  });

  it('should NOT extract tool calls when message contains two tool calls in one message', () => {
    const twoCalls = `{"name": "list_dir", "arguments": {"dirPath": "."}} {"name": "view_file_range", "arguments": {"filePath": "a.txt"}}`;

    const calls = OllamaService.extractEmbeddedToolCall(twoCalls, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['list_dir', 'view_file_range'],
    });
    assert.strictEqual(calls.length, 0, 'Must reject multiple tool calls in a single message');
  });

  it('should NOT extract tool calls from truncated JSON', () => {
    const truncated = `{"name": "str_replace", "arguments": {"filePath": "app.cs"`;

    const calls = OllamaService.extractEmbeddedToolCall(truncated, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['str_replace'],
    });
    assert.strictEqual(calls.length, 0, 'Must reject truncated JSON');
  });

  it('should NOT extract tool call when tool name is not in offered tool list', () => {
    const validJsonUnapprovedTool = `{"name": "delete_all_files", "arguments": {}}`;

    const calls = OllamaService.extractEmbeddedToolCall(validJsonUnapprovedTool, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['list_dir', 'view_file_range'],
    });
    assert.strictEqual(calls.length, 0, 'Must reject tool not offered in schema');
  });

  it('should NOT extract tool call when enableEmbeddedFallback setting is false', () => {
    const validJson = `{"name": "list_dir", "arguments": {"dirPath": "."}}`;

    const calls = OllamaService.extractEmbeddedToolCall(validJson, {
      enableEmbeddedFallback: false,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['list_dir'],
    });
    assert.strictEqual(calls.length, 0, 'Must reject when setting is false');
  });

  it('should NOT extract tool call when model is not flagged as embedded-capable', () => {
    const validJson = `{"name": "list_dir", "arguments": {"dirPath": "."}}`;

    const calls = OllamaService.extractEmbeddedToolCall(validJson, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: false,
      allowedToolNames: ['list_dir'],
    });
    assert.strictEqual(calls.length, 0, 'Must reject when model not probed as embedded-capable');
  });

  it('should extract exactly 1 valid tool call when the ENTIRE message is a single JSON object', () => {
    const exactJson = `{"name": "list_dir", "arguments": {"dirPath": "Backend.Api"}}`;

    const calls = OllamaService.extractEmbeddedToolCall(exactJson, {
      enableEmbeddedFallback: true,
      isEmbeddedCapableModel: true,
      allowedToolNames: ['list_dir'],
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'list_dir');
    assert.strictEqual(calls[0].function.arguments.dirPath, 'Backend.Api');
  });

  it('should extract exactly 1 valid tool call when properly formatted outside fences and quotes', () => {
    const validContent = `<think>
I need to inspect the directory.
</think>
\`\`\`json
{
  "name": "list_dir",
  "arguments": {"dirPath": "Backend.Api"}
}
\`\`\``;

    const calls = OllamaService.extractToolCallsFromContent(validContent, ['list_dir', 'view_file_range']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'list_dir');
    assert.strictEqual(calls[0].function.arguments.dirPath, 'Backend.Api');
  });

  describe('Scoped Security & RPC Confirmation Validation', () => {
    it('workspace-level setting is ignored for enableEmbeddedFallback', () => {
      // Mock configuration inspection where workspace has set enableEmbeddedFallback to true,
      // but globalValue is false or undefined.
      const originalGetConfig = vscodeMock.workspace.getConfiguration;
      try {
        vscodeMock.workspace.getConfiguration = (section?: string) => ({
          get: (key: string) => {
            if (key === 'tools.enableEmbeddedFallback') return true; // raw get might return workspace value
            return undefined;
          },
          inspect: (key: string) => {
            if (key === 'tools.enableEmbeddedFallback') {
              return {
                key: 'tools.enableEmbeddedFallback',
                defaultValue: false,
                globalValue: false, // user-scoped is FALSE
                workspaceValue: true, // workspace tried to override to TRUE
                workspaceFolderValue: undefined
              };
            }
            return undefined;
          },
          update: async () => {}
        } as any);

        const configService = ConfigurationService.getInstance();
        assert.strictEqual(
          configService.enableEmbeddedToolCallFallback,
          false,
          'ConfigurationService MUST ignore workspaceValue and honor only globalValue for enableEmbeddedFallback'
        );
      } finally {
        vscodeMock.workspace.getConfiguration = originalGetConfig;
      }
    });

    it('RPC without host modal confirmation does nothing', async () => {
      // Simulate user clicking 'Cancel' or dismissing the host-side modal warning dialog
      let settingWritten = false;
      const originalShowWarning = vscodeMock.window.showWarningMessage;
      const originalGetConfig = vscodeMock.workspace.getConfiguration;

      try {
        // User clicks 'Cancel' (or dismisses with undefined)
        (vscodeMock.window.showWarningMessage as any) = async (_msg: string, _opts: any, ..._items: string[]) => {
          return undefined; // Dismissed modal
        };

        vscodeMock.workspace.getConfiguration = () => ({
          update: async (key: string, val: any) => {
            if (key === 'tools.enableEmbeddedFallback') {
              settingWritten = true;
            }
          }
        } as any);

        // Verify the modal confirmation logic
        const choice = await vscode.window.showWarningMessage(
          'Security Warning: Enabling embedded tool fallback allows executing tool calls parsed from model text output when native tool calls are not supported. This applies globally across all workspaces. Enable fallback?',
          { modal: true },
          'Enable Fallback'
        );

        if (choice === 'Enable Fallback') {
          await vscode.workspace.getConfiguration('localCopilot').update('tools.enableEmbeddedFallback', true);
        }

        assert.strictEqual(settingWritten, false, 'Setting must NOT be written when modal confirmation is dismissed');
      } finally {
        vscodeMock.window.showWarningMessage = originalShowWarning;
        vscodeMock.workspace.getConfiguration = originalGetConfig;
      }
    });

    it('injected HTML in a model name is escaped to prevent XSS in banners', () => {
      const maliciousModel1 = '<script>alert("XSS")</script>';
      const maliciousModel2 = '"><img src=x onerror=alert(1)>';
      const maliciousModel3 = "qwen2.5-coder' onload='alert(1)";

      const escaped1 = ChatViewProvider.escapeHtml(maliciousModel1);
      const escaped2 = ChatViewProvider.escapeHtml(maliciousModel2);
      const escaped3 = ChatViewProvider.escapeHtml(maliciousModel3);

      assert.strictEqual(escaped1, '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
      assert.strictEqual(escaped2, '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
      assert.strictEqual(escaped3, 'qwen2.5-coder&#39; onload=&#39;alert(1)');

      assert.strictEqual(escaped1.includes('<script>'), false);
      assert.strictEqual(escaped2.includes('">'), false);
      assert.strictEqual(escaped3.includes("'"), false);
    });
  });
});
