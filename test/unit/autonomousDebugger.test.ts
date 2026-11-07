import * as assert from 'assert';
import * as path from 'path';
import { AutonomousDebuggerService } from '../../src/services/autonomousDebuggerService';
import { AgentToolService } from '../../src/services/agentToolService';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, mockFs, MockUri, setMockWorkspaceFolders } from '../mocks/vscodeMock';

describe('Phase 6.3: Autonomous Debugging & Diagnostic Intelligence Suite', () => {
  let debuggerService: AutonomousDebuggerService;
  const workspaceRoot = 'C:\\Projects\\my-project';

  beforeEach(() => {
    debuggerService = new AutonomousDebuggerService();
  });

  it('should parse Node/V8 stack trace and identify workspace culprit while ignoring node_modules', () => {
    const rawError = `
TypeError: Cannot read properties of undefined (reading 'name')
    at Object.getUser (C:\\Projects\\my-project\\src\\services\\userService.ts:42:15)
    at runNextTicks (node:internal/process/task_queues:60:5)
    at listOnTimeout (node:internal/timers:540:9)
    at process.processTimers (node:internal/timers:514:7)
`;

    const diagnostic = debuggerService.parseError(rawError, workspaceRoot);

    assert.strictEqual(diagnostic.category, 'null_pointer');
    assert.strictEqual(diagnostic.frames.length, 4);

    // Primary culprit must skip internal/node_modules and pick userService.ts
    assert.ok(diagnostic.primaryCulprit);
    assert.strictEqual(
      diagnostic.primaryCulprit?.filePath.toLowerCase(),
      path.normalize('C:\\Projects\\my-project\\src\\services\\userService.ts').toLowerCase()
    );
    assert.strictEqual(diagnostic.primaryCulprit?.line, 42);
    assert.strictEqual(diagnostic.primaryCulprit?.column, 15);
    assert.strictEqual(diagnostic.primaryCulprit?.functionName, 'Object.getUser');
  });

  it('should parse TypeScript compiler diagnostics accurately', () => {
    const rawError = `
src/controllers/auth.ts(88,24): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
`;

    const diagnostic = debuggerService.parseError(rawError, workspaceRoot);

    assert.strictEqual(diagnostic.category, 'type_mismatch');
    assert.strictEqual(diagnostic.frames.length, 1);
    assert.strictEqual(diagnostic.primaryCulprit?.line, 88);
    assert.strictEqual(diagnostic.primaryCulprit?.column, 24);
    assert.strictEqual(diagnostic.primaryCulprit?.functionName, 'TS2345');
  });

  it('should parse Python tracebacks with file, line, and function name', () => {
    const rawError = `
Traceback (most recent call last):
  File "C:\\Python310\\lib\\runpy.py", line 196, in _run_module_as_main
  File "C:\\Projects\\my-project\\app\\main.py", line 15, in handle_request
AttributeError: 'NoneType' object has no attribute 'get'
`;

    const diagnostic = debuggerService.parseError(rawError, workspaceRoot);

    assert.strictEqual(diagnostic.category, 'null_pointer');
    assert.strictEqual(diagnostic.frames.length, 2);
    assert.ok(diagnostic.primaryCulprit);
    assert.strictEqual(
      diagnostic.primaryCulprit?.filePath.toLowerCase(),
      path.normalize('C:\\Projects\\my-project\\app\\main.py').toLowerCase()
    );
    assert.strictEqual(diagnostic.primaryCulprit?.line, 15);
    assert.strictEqual(diagnostic.primaryCulprit?.functionName, 'handle_request');
  });

  it('should generate targeted hypotheses and reproduction command for assertion failures', () => {
    const rawError = `
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual: 200
- expected: 404
    at Context.<anonymous> (C:\\Projects\\my-project\\test\\auth.test.ts:35:12)
`;

    const result = debuggerService.analyzeAndGenerateHypotheses(rawError, workspaceRoot);

    assert.strictEqual(result.diagnostic.category, 'assertion_failure');
    assert.strictEqual(result.hypotheses.length, 1);
    assert.strictEqual(result.hypotheses[0].category, 'assertion_failure');
    assert.ok(result.hypotheses[0].suggestedAction.includes('Verify input transformations'));
    assert.strictEqual(result.hypotheses[0].targetLine, 35);
    assert.ok(result.reproductionCommand?.includes('auth.test.ts'));
  });

  it('should generate targeted hypotheses for missing exports', () => {
    const rawError = `
Error: Module 'C:\\Projects\\my-project\\src\\utils.ts' has no exported member 'formatCurrency'.
    at Object.<anonymous> (C:\\Projects\\my-project\\src\\views.ts:5:1)
`;

    const result = debuggerService.analyzeAndGenerateHypotheses(rawError, workspaceRoot);

    assert.strictEqual(result.diagnostic.category, 'missing_export');
    assert.strictEqual(result.hypotheses[0].category, 'missing_export');
    assert.ok(result.hypotheses[0].suggestedAction.includes('export'));
  });

  describe('Autonomous /fix Execution Workflow', () => {
    beforeEach(() => {
      resetMockState(workspaceRoot);
      setMockWorkspaceFolders([
        { name: 'my-project', uri: MockUri.file(workspaceRoot), index: 0 }
      ]);
    });

    it('should diagnose error, generate surgical patch, verify build check, and apply cleanly', async () => {
      const targetFilePath = path.join(workspaceRoot, 'src', 'calc.ts');
      mockFs.setFile(targetFilePath, 'export function divide(a: number, b: number) {\n  return a / b;\n}');

      const mockOllama: any = {
        streamChat: async (
          model: string,
          messages: any[],
          onChunk: (chunk: string) => void
        ) => {
          onChunk(`\`\`\`patch\nSEARCH:\nreturn a / b;\nREPLACE:\nif (b === 0) throw new Error("ZeroDivision");\n  return a / b;\n\`\`\``);
        }
      };

      const origCheckBuild = AgentToolService.checkBuild;
      try {
        AgentToolService.checkBuild = async () => ({ success: true, output: 'Build clean' });

        const errorLog = `
TypeError: ZeroDivisionError
    at divide (C:\\Projects\\my-project\\src\\calc.ts:2:5)
`;
        const progressEvents: string[] = [];
        const result = await AutonomousDebuggerService.executeFixWorkflow(
          errorLog,
          mockOllama as unknown as OllamaService,
          'qwen2.5-coder:7b',
          (msg) => progressEvents.push(msg)
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.verified, true);
        assert.ok(result.message.includes('fixed successfully'));

        const updatedFile = mockFs.getFile(targetFilePath);
        assert.ok(updatedFile?.includes('if (b === 0) throw new Error("ZeroDivision");'));
      } finally {
        AgentToolService.checkBuild = origCheckBuild;
      }
    });

    it('should rollback patch if post-verification build check fails', async () => {
      const targetFilePath = path.join(workspaceRoot, 'src', 'calc.ts');
      const originalCode = 'export function divide(a: number, b: number) {\n  return a / b;\n}';
      mockFs.setFile(targetFilePath, originalCode);

      const mockOllama: any = {
        streamChat: async (
          model: string,
          messages: any[],
          onChunk: (chunk: string) => void
        ) => {
          onChunk(`\`\`\`patch\nSEARCH:\nreturn a / b;\nREPLACE:\nreturn a // syntax error;\n\`\`\``);
        }
      };

      const origCheckBuild = AgentToolService.checkBuild;
      try {
        // Build fails on bad syntax
        AgentToolService.checkBuild = async () => ({ success: false, output: 'Syntax error TS1005' });

        const errorLog = `
TypeError: Error
    at divide (C:\\Projects\\my-project\\src\\calc.ts:2:5)
`;
        const progressEvents: string[] = [];
        const result = await AutonomousDebuggerService.executeFixWorkflow(
          errorLog,
          mockOllama as unknown as OllamaService,
          'qwen2.5-coder:7b',
          (msg) => progressEvents.push(msg)
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.verified, false);
        assert.ok(result.message.includes('rolled back'));

        // Target file must be rolled back to original
        assert.strictEqual(mockFs.getFile(targetFilePath), originalCode);
      } finally {
        AgentToolService.checkBuild = origCheckBuild;
      }
    });
  });
});
