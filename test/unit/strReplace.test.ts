import * as assert from 'assert';
import * as path from 'path';
import { AgentToolService } from '../../src/services/agentToolService';
import { resetMockState, mockFs } from '../mocks/vscodeMock';

describe('Surgical Code Editing (str_replace) Baseline', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(() => {
    resetMockState(testRoot);
  });

  it('should successfully replace a unique string in an LF document', async () => {
    const filePath = 'Backend.Api/Program.cs';
    const originalContent = [
      'var builder = WebApplication.CreateBuilder(args);',
      'builder.Services.AddControllers();',
      'var app = builder.Build();',
      'app.Run();'
    ].join('\n');

    mockFs.setFile(path.join(testRoot, filePath), originalContent);

    const oldStr = 'builder.Services.AddControllers();';
    const newStr = 'builder.Services.AddControllers();\nbuilder.Services.AddEndpointsApiExplorer();';

    const result = await AgentToolService.strReplace(filePath, oldStr, newStr);
    assert.strictEqual(result.success, true);
    assert.match(result.output, /Successfully replaced code/);

    const updated = mockFs.getFile(path.join(testRoot, filePath));
    assert.ok(updated?.includes('builder.Services.AddEndpointsApiExplorer();'));
  });

  it('should fail with line hints when target string is not found', async () => {
    const filePath = 'Models/TaskItem.cs';
    const originalContent = [
      'public class TaskItem {',
      '    public int Id { get; set; }',
      '    public string Title { get; set; }',
      '}'
    ].join('\n');

    mockFs.setFile(path.join(testRoot, filePath), originalContent);

    const result = await AgentToolService.strReplace(filePath, 'public string NonExistentProperty { get; set; }', 'replacement');
    assert.strictEqual(result.success, false);
    assert.match(result.output, /not found in/i);
    assert.match(result.output, /Please use view_file_range to verify/i);
  });

  it('should detect duplicate occurrences and reject replacement for ambiguity', async () => {
    const filePath = 'Services/ItemService.cs';
    const originalContent = [
      'public void DoSomething() {',
      '    int x = 10;',
      '    Process(x);',
      '}',
      'public void DoAnother() {',
      '    int x = 10;',
      '    Process(x);',
      '}'
    ].join('\n');

    mockFs.setFile(path.join(testRoot, filePath), originalContent);

    const result = await AgentToolService.strReplace(filePath, 'int x = 10;', 'int x = 20;');
    assert.strictEqual(result.success, false);
    assert.match(result.output, /occurs 2 times/i);
    assert.match(result.output, /Please expand oldStr/i);
  });

  it('should evaluate CRLF multi-line document replacement accuracy', async () => {
    const filePath = 'Config/Settings.cs';
    // Document with CRLF line endings
    const crlfContent = [
      '// Header line 1',
      '// Header line 2',
      '// Header line 3',
      'public class Settings {',
      '    public int Port = 8080;',
      '}'
    ].join('\r\n');

    mockFs.setFile(path.join(testRoot, filePath), crlfContent);

    const oldStr = '    public int Port = 8080;';
    const newStr = '    public int Port = 9090;';

    const result = await AgentToolService.strReplace(filePath, oldStr, newStr);

    // Check if result succeeded
    assert.strictEqual(result.success, true);
    const updated = mockFs.getFile(path.join(testRoot, filePath));
    assert.ok(updated?.includes('Port = 9090;'), 'Expected Port = 9090 to be present');
  });
});
