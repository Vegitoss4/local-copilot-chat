import * as assert from 'assert';
import { OllamaService } from '../../src/services/ollamaService';

describe('Scoped Fix: DeepSeek-R1 Content Tool Parsing & Reason Cleaning Suite', () => {
  it('should parse fenced JSON tool call following </think> reasoning block', () => {
    const output = `<think>
I need to inspect the directory contents to understand the structure.
Let's call list_dir.
</think>
\`\`\`json
{
  "name": "list_dir",
  "arguments": {
    "dirPath": "Backend.Api/Controllers"
  }
}
\`\`\``;

    const calls = OllamaService.extractToolCallsFromContent(output);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'list_dir');
    assert.strictEqual(calls[0].function.arguments.dirPath, 'Backend.Api/Controllers');
  });

  it('should parse raw JSON tool call following </think> block without markdown fences', () => {
    const output = `<think>
Need to read the first 50 lines of TaskItemsController.cs
</think>
{"name": "view_file_range", "arguments": {"filePath": "TaskItemsController.cs", "startLine": 1, "endLine": 50}}
`;

    const calls = OllamaService.extractToolCallsFromContent(output);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'view_file_range');
    assert.strictEqual(calls[0].function.arguments.filePath, 'TaskItemsController.cs');
    assert.strictEqual(calls[0].function.arguments.startLine, 1);
    assert.strictEqual(calls[0].function.arguments.endLine, 50);
  });

  it('should parse tool call with "tool" and "parameters" alternate keywords', () => {
    const output = `<think>
Applying fix
</think>
{"tool": "str_replace", "parameters": {"filePath": "app.cs", "oldStr": "foo", "newStr": "bar"}}`;

    const calls = OllamaService.extractToolCallsFromContent(output);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'str_replace');
    assert.strictEqual(calls[0].function.arguments.oldStr, 'foo');
    assert.strictEqual(calls[0].function.arguments.newStr, 'bar');
  });

  it('should parse nested arguments without truncation', () => {
    const output = `<think>deep thought</think>
{"name": "execute_task", "arguments": {"options": {"deep": true, "sub": {"id": 42}}}}`;

    const calls = OllamaService.extractToolCallsFromContent(output);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'execute_task');
    assert.strictEqual(calls[0].function.arguments.options.sub.id, 42);
  });

  it('should handle native <tool_call> XML blocks accurately', () => {
    const output = `<tool_call>{"name": "check_build", "arguments": {"projectPath": "Backend.Api.csproj"}}</tool_call>`;

    const calls = OllamaService.extractToolCallsFromContent(output);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'check_build');
    assert.strictEqual(calls[0].function.arguments.projectPath, 'Backend.Api.csproj');
  });
});
