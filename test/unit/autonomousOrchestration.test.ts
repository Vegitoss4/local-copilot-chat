import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AutonomousOrchestrationEngine,
  OrchestratorHandlers,
  OrchestrationTaskPlan,
  ReviewFeedback
} from '../../src/services/autonomousOrchestrator';
import { resetMockState, mockFs, MockUri, setMockWorkspaceFolders } from '../mocks/vscodeMock';
import { AgentToolService } from '../../src/services/agentToolService';

describe('Phase 6.5: Autonomous Agent Planning & Orchestration Suite', () => {
  let engine: AutonomousOrchestrationEngine;
  const workspaceRoot = 'C:\\Projects\\test-workspace';

  beforeEach(() => {
    resetMockState(workspaceRoot);
    setMockWorkspaceFolders([
      { name: 'test-workspace', uri: MockUri.file(workspaceRoot), index: 0 }
    ]);
    engine = new AutonomousOrchestrationEngine(3);
  });

  afterEach(() => {
    resetMockState(workspaceRoot);
  });

  it('should execute full pipeline (Architect -> Dev -> Test -> Review) to COMPLETED in 1 turn', async () => {
    const handlers: OrchestratorHandlers = {
      runArchitect: async (objective) => ({
        objective,
        acceptanceCriteria: ['Create health check endpoint', 'Tests pass'],
        plannedFiles: ['src/health.ts']
      }),
      runDeveloper: async (plan) => ({
        modifiedFiles: ['src/health.ts'],
        logs: 'Implemented health check'
      }),
      runTester: async (files) => [
        { name: 'health check test', passed: true }
      ],
      runReviewer: async (plan, tests) => ({
        approved: true,
        notes: 'All criteria satisfied'
      })
    };

    const result = await engine.executePipeline('task-101', 'Build health check', handlers);

    assert.strictEqual(result.stage, 'COMPLETED');
    assert.strictEqual(result.iteration, 1);
    assert.strictEqual(result.modifiedFiles.length, 1);
    assert.strictEqual(result.reviewHistory.length, 1);
    assert.strictEqual(result.reviewHistory[0].approved, true);

    // Verify whiteboard persisted
    const whiteboardPath = path.join(workspaceRoot, '.vscode', 'local-copilot', 'orchestration', 'whiteboard-task-101.json');
    assert.ok(mockFs.getFile(whiteboardPath) !== undefined);
  });

  it('should handle rejection feedback loop and succeed on second iteration', async () => {
    let devCallCount = 0;

    const handlers: OrchestratorHandlers = {
      runArchitect: async (objective) => ({
        objective,
        acceptanceCriteria: ['Feature implemented', 'No regressions'],
        plannedFiles: ['src/feature.ts']
      }),
      runDeveloper: async (plan, feedback) => {
        devCallCount++;
        if (devCallCount === 1) {
          return { modifiedFiles: ['src/feature.ts'], logs: 'Initial incomplete draft' };
        } else {
          assert.ok(feedback?.notes.includes('Missing edge case tests'));
          return { modifiedFiles: ['src/feature.ts', 'test/feature.test.ts'], logs: 'Added edge case tests' };
        }
      },
      runTester: async (files) => {
        if (devCallCount === 1) {
          return [{ name: 'edge test', passed: false, error: 'Not implemented' }];
        }
        return [{ name: 'edge test', passed: true }];
      },
      runReviewer: async (plan, tests) => {
        const allPassed = tests.every(t => t.passed);
        if (!allPassed) {
          return { approved: false, notes: 'Missing edge case tests', missingCriteria: ['Tests pass'] };
        }
        return { approved: true, notes: 'Fully compliant' };
      }
    };

    const result = await engine.executePipeline('task-102', 'Complex feature', handlers);

    assert.strictEqual(result.stage, 'COMPLETED');
    assert.strictEqual(result.iteration, 2);
    assert.strictEqual(devCallCount, 2);
    assert.strictEqual(result.reviewHistory.length, 2);
    assert.strictEqual(result.reviewHistory[0].approved, false);
    assert.strictEqual(result.reviewHistory[1].approved, true);
  });

  it('should terminate with FAILED when max iterations threshold is reached without approval', async () => {
    const handlers: OrchestratorHandlers = {
      runArchitect: async (objective) => ({
        objective,
        acceptanceCriteria: ['Impossible criteria'],
        plannedFiles: ['src/impossible.ts']
      }),
      runDeveloper: async (plan) => ({
        modifiedFiles: ['src/impossible.ts'],
        logs: 'Attempted implementation'
      }),
      runTester: async () => [{ name: 'test', passed: false, error: 'Still failing' }],
      runReviewer: async () => ({
        approved: false,
        notes: 'Criteria not satisfied'
      })
    };

    const result = await engine.executePipeline('task-103', 'Impossible task', handlers);

    assert.strictEqual(result.stage, 'FAILED');
    assert.strictEqual(result.iteration, 3);
    assert.strictEqual(result.reviewHistory.length, 3);
  });

  it('should halt pipeline immediately when cancellation is requested', async () => {
    const tokenSource = new vscode.CancellationTokenSource();
    tokenSource.cancel();

    const handlers: OrchestratorHandlers = {
      runArchitect: async () => ({ objective: 'cancelled', acceptanceCriteria: [], plannedFiles: [] }),
      runDeveloper: async () => ({ modifiedFiles: [], logs: '' }),
      runTester: async () => [],
      runReviewer: async () => ({ approved: true, notes: '' })
    };

    const result = await engine.executePipeline('task-104', 'Abort task', handlers, undefined, tokenSource.token);

    assert.strictEqual(result.stage, 'FAILED');
    assert.strictEqual(result.iteration, 0);
  });

  it('should connect default handlers to real LLM prompting with Architect, Developer, Tester and Reviewer', async () => {
    const mockOllama: any = {
      streamChat: async (_model: string, msgs: any[]) => {
        const prompt = msgs[msgs.length - 1]?.content || '';
        if (prompt.includes('Principal Software Architect')) {
          return JSON.stringify({
            objective: 'Build Auth Controller',
            acceptanceCriteria: ['Valid login', 'Valid logout'],
            plannedFiles: ['src/auth.ts']
          });
        }
        if (prompt.includes('Principal Code Reviewer')) {
          return JSON.stringify({
            approved: true,
            notes: 'Code meets all criteria and tests passed.',
            missingCriteria: []
          });
        }
        return 'Done';
      },
      resolveModelForPhase: () => 'qwen2.5-coder:7b'
    };

    const origCheckBuild = AgentToolService.checkBuild;
    AgentToolService.checkBuild = async () => ({ success: true, output: 'Build ok' });

    try {
      const defaultHandlers = AutonomousOrchestrationEngine.createDefaultHandlers(
        mockOllama,
        'qwen2.5-coder:7b',
        MockUri.file(workspaceRoot)
      );

      const plan = await defaultHandlers.runArchitect('Build Auth Controller');
      assert.strictEqual(plan.objective, 'Build Auth Controller');
      assert.strictEqual(plan.plannedFiles[0], 'src/auth.ts');

      const tests = await defaultHandlers.runTester(plan.plannedFiles);
      assert.strictEqual(tests[0].passed, true);

      const review = await defaultHandlers.runReviewer(plan, tests);
      assert.strictEqual(review.approved, true);
    } finally {
      AgentToolService.checkBuild = origCheckBuild;
    }
  });
});
