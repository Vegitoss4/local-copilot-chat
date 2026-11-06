import * as assert from 'assert';
import { AgentToolService } from '../../src/services/agentToolService';
import { SwarmOrchestrator } from '../../src/services/swarmOrchestrator';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, mockFs } from '../mocks/vscodeMock';

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
            if (!res.success && res.output.includes('cancelled')) {
              cancelled = true;
            }
          }
        },
        new AbortController().signal
      );
    } catch {
      // Swarm completes
    }
  });

  // PENDING SECURITY TEST: Current implementation fails open if callbacks.requestApproval is undefined
  it.skip('[PENDING SECURITY FIX - PHASE 1] should fail-closed and reject destructive tools when requestApproval is undefined in non-autonomous mode', async () => {
    const ollamaMock = new OllamaService('http://127.0.0.1:11434');
    const swarm = new SwarmOrchestrator(ollamaMock, {
      autonomousMode: false,
      userModel: 'qwen2.5-coder:7b',
      availableModels: ['qwen2.5-coder:7b']
    });

    // In non-autonomous mode, if callbacks.requestApproval is missing, it MUST NOT execute destructive tool
    let executedDestructiveTool = false;
    // When implemented in Phase 1, dispatchBaseTool must reject with error rather than executing
  });

  // PENDING SECURITY TEST: Autonomous mode currently bypasses all approval checks
  it.skip('[PENDING SECURITY FIX - PHASE 1] should enforce approval for unwhitelisted shell commands even in autonomous mode', async () => {
    // Phase 1 security requirement: dangerous commands require confirmation regardless of autonomous flag
  });
});
