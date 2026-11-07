import * as assert from 'assert';
import { AgentToolService } from '../../src/services/agentToolService';
import { SwarmOrchestrator } from '../../src/services/swarmOrchestrator';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, mockFs } from '../mocks/vscodeMock';
import { PathSecurity } from '../../src/services/pathSecurity';

describe('Tool Execution Safety & Approval Gates Baseline', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(() => {
    resetMockState(testRoot);
  });

  it('should correctly classify destructive modification tools', () => {
    const destructive = ['str_replace', 'create_file', 'apply_patch', 'execute_command'];
    for (const tool of destructive) {
      assert.strictEqual(
        AgentToolService.isDestructiveTool(tool),
        true,
        `Expected ${tool} to be classified as destructive`
      );
    }
  });

  it('should correctly classify read-only inspection tools as non-destructive', () => {
    const nonDestructive = [
      'view_file_range',
      'search_workspace',
      'list_dir',
      'get_diagnostics',
      'semantic_search',
      'ask_user',
      'store_memory'
    ];
    for (const tool of nonDestructive) {
      assert.strictEqual(
        AgentToolService.isDestructiveTool(tool),
        false,
        `Expected ${tool} to be classified as non-destructive`
      );
    }
  });

  it('should cancel operation when user denies approval in non-autonomous mode', async () => {
    const ollamaMock = new OllamaService('http://127.0.0.1:11434');
    // Mock chatWithTools to simulate a model issuing a destructive tool call
    ollamaMock.chatWithTools = async () => {
      return {
        role: 'assistant',
        content: 'I will create a file',
        tool_calls: [
          {
            id: 'call_test_1',
            function: {
              name: 'create_file',
              arguments: { path: 'test.txt', content: 'test content' }
            }
          }
        ]
      };
    };

    const swarm = new SwarmOrchestrator(ollamaMock, {
      autonomousMode: false,
      userModel: 'qwen2.5-coder:7b',
      availableModels: ['qwen2.5-coder:7b']
    });

    let requestedApproval = false;
    let cancelled = false;

    // Call runTask with a rejection resolver
    try {
      await swarm.runTask(
        'Delete something',
        {
          requestApproval: async (req) => {
            requestedApproval = true;
            return false; // User denies
          },
          onToolEnd: (res) => {
            if (!res.success && res.output && res.output.includes('cancelled')) {
              cancelled = true;
            }
          }
        },
        new AbortController().signal
      );
    } catch {
      // Swarm completes
    }

    assert.strictEqual(requestedApproval, true, 'User approval should have been requested');
    assert.strictEqual(cancelled, true, 'Tool execution should have been cancelled');
  });

  it('should fail-closed and reject destructive tools when requestApproval is undefined in non-autonomous mode', async () => {
    const ollamaMock = new OllamaService('http://127.0.0.1:11434');
    ollamaMock.chatWithTools = async () => ({
      role: 'assistant',
      content: 'I will create a file',
      tool_calls: [
        {
          id: 'call_test_fail_closed',
          function: {
            name: 'create_file',
            arguments: { path: 'fail_closed.txt', content: 'hello' },
          },
        },
      ],
    });
    (ollamaMock as any).resolveModelForRole = (_role: any, fallback: string) => fallback;

    const swarm = new SwarmOrchestrator(ollamaMock, {
      autonomousMode: false,
      userModel: 'qwen2.5-coder:7b',
      availableModels: ['qwen2.5-coder:7b'],
    });

    let toolResult: any = null;
    try {
      await swarm.runTask(
        'Write file',
        {
          // Notice: requestApproval callback is omitted!
          onToolEnd: (res) => {
            toolResult = res;
          },
        },
        new AbortController().signal
      );
    } catch {}

    assert.ok(toolResult, 'Tool should have been dispatched');
    assert.strictEqual(toolResult.success, false, 'Destructive tool should have failed closed');
    assert.ok(
      toolResult.output.includes('fail-closed') || toolResult.output.includes('approval'),
      `Output should indicate approval policy rejection: ${toolResult.output}`
    );
    assert.strictEqual(mockFs.getFile('C:/Projects/test-workspace/fail_closed.txt'), undefined, 'File must not be created');
  });

  it('should enforce approval for unwhitelisted shell commands even in autonomous mode', async () => {
    const ollamaMock = new OllamaService('http://127.0.0.1:11434');
    ollamaMock.chatWithTools = async () => ({
      role: 'assistant',
      content: 'I will run a command',
      tool_calls: [
        {
          id: 'call_test_cmd_approval',
          function: {
            name: 'execute_command',
            arguments: { command: 'npm install lodash' },
          },
        },
      ],
    });
    (ollamaMock as any).resolveModelForRole = (_role: any, fallback: string) => fallback;

    const swarm = new SwarmOrchestrator(ollamaMock, {
      autonomousMode: true, // Autonomous mode is enabled!
      userModel: 'qwen2.5-coder:7b',
      availableModels: ['qwen2.5-coder:7b'],
    });

    let approvalRequested = false;
    let toolResult: any = null;
    try {
      await swarm.runTask(
        'Install package',
        {
          requestApproval: async () => {
            approvalRequested = true;
            return false; // User denies
          },
          onToolEnd: (res) => {
            toolResult = res;
          },
        },
        new AbortController().signal
      );
    } catch {}

    assert.strictEqual(approvalRequested, true, 'Approval must be requested for Tier 3 command even in autonomous mode');
    assert.ok(toolResult);
    assert.strictEqual(toolResult.success, false);
    assert.ok(toolResult.output.includes('cancelled') || toolResult.output.includes('denied'));
  });

  describe('Autonomous Sensitive Target Defense Policy', () => {
    it('should classify sensitive files and directories accurately', () => {
      const sensitive = [
        '.git/hooks/pre-commit',
        '.github/workflows/deploy.yml',
        '.gitlab-ci.yml',
        '.env',
        '.env.production',
        '.npmrc',
        'package.json',
        'tasks.json',
        'launch.json',
        'deploy.sh',
        'build.ps1',
        'run.cmd',
        'install.bat'
      ];
      for (const p of sensitive) {
        assert.strictEqual(PathSecurity.isSensitiveTarget(p), true, `Expected "${p}" to be classified as sensitive`);
      }

      const regular = [
        'src/index.ts',
        'src/components/App.tsx',
        'README.md',
        'styles/main.css',
        'test/unit/math.test.ts'
      ];
      for (const p of regular) {
        assert.strictEqual(PathSecurity.isSensitiveTarget(p), false, `Expected "${p}" to NOT be sensitive`);
      }
    });

    it('should enforce approval in SwarmOrchestrator for sensitive targets even in autonomous mode', async () => {
      const ollamaMock = new OllamaService('http://127.0.0.1:11434');
      ollamaMock.chatWithTools = async () => ({
        role: 'assistant',
        content: 'Modifying workflow',
        tool_calls: [
          {
            id: 'call_sens_swarm',
            function: {
              name: 'create_file',
              arguments: { filePath: '.github/workflows/deploy.yml', content: 'name: evil' },
            },
          },
        ],
      });
      (ollamaMock as any).resolveModelForRole = (_role: any, fallback: string) => fallback;

      const swarm = new SwarmOrchestrator(ollamaMock, {
        autonomousMode: true, // Autonomous mode is enabled!
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      let approvalPrompted = false;
      await swarm.runTask(
        'Update deploy workflow',
        {
          requestApproval: async (req) => {
            approvalPrompted = true;
            assert.strictEqual(req.toolName, 'create_file');
            return false; // Deny
          },
        },
        new AbortController().signal
      );

      assert.strictEqual(approvalPrompted, true, 'SwarmOrchestrator MUST require approval for sensitive target');
    });
  });
});
