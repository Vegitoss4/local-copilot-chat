import * as assert from 'assert';
import {
  PlanModeDispatcher,
  PlanModeViolationError,
  StructuredPlan
} from '../../src/services/planModeDispatcher';
import { ToolCall } from '../../src/services/agentToolService';

describe('Deliverable 11.4: Read-Only Plan Mode & Strict Dispatcher Enforcement Suite', () => {
  describe('Tool Whitelist Filtering', () => {
    it('should permit strictly read-only inspection tools in Plan Mode', () => {
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('readFile'), true);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('listFiles'), true);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('searchWorkspace'), true);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('getWorkspaceSummary'), true);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('getGitDiff'), true);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('checkBuild'), true);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('getDiagnostics'), true);
    });

    it('should prohibit destructive write, patch, and execution tools in Plan Mode', () => {
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('writeFile'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('replaceString'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('applyPatch'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('executeCommand'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('deleteFile'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('runTerminalCommand'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted('createFile'), false);
      assert.strictEqual(PlanModeDispatcher.isToolPermitted(''), false);
    });

    it('should filter an array of tool definitions to only retain permitted read-only tools', () => {
      const mixedTools = [
        { function: { name: 'readFile' } },
        { function: { name: 'writeFile' } },
        { function: { name: 'executeCommand' } },
        { function: { name: 'searchWorkspace' } },
        { function: { name: 'applyPatch' } }
      ];

      const filtered = PlanModeDispatcher.filterAllowedTools(mixedTools);
      assert.strictEqual(filtered.length, 2);
      assert.strictEqual(filtered[0].function.name, 'readFile');
      assert.strictEqual(filtered[1].function.name, 'searchWorkspace');
    });
  });

  describe('Tool Call Interception & Fail-Closed Enforcement', () => {
    it('should allow permitted read-only tool calls through', () => {
      const readCall: ToolCall = {
        id: 'call_read_01',
        function: {
          name: 'readFile',
          arguments: { path: 'src/index.ts' }
        }
      };

      const interception = PlanModeDispatcher.interceptToolCall(readCall);
      assert.strictEqual(interception.permitted, true);
      assert.strictEqual(interception.errorResult, undefined);
    });

    it('should intercept and reject destructive tool calls with error result', () => {
      const writeCall: ToolCall = {
        id: 'call_write_01',
        function: {
          name: 'writeFile',
          arguments: { path: 'src/malicious.ts', content: 'alert(1)' }
        }
      };

      const interception = PlanModeDispatcher.interceptToolCall(writeCall);
      assert.strictEqual(interception.permitted, false);
      assert.ok(interception.errorResult);
      assert.strictEqual(interception.errorResult.success, false);
      assert.ok(interception.errorResult.output.includes('PLAN MODE ENFORCEMENT'));
      assert.ok(interception.errorResult.output.includes('strictly read-only'));
    });
  });

  describe('Structured Plan Validation & Parsing', () => {
    it('should parse valid structured plan from markdown JSON fence', () => {
      const planJson = JSON.stringify({
        planTitle: 'Database Connection Pool Migration',
        goal: 'Upgrade DB connection pool to avoid socket leaks',
        affectedFiles: ['src/db.ts', 'src/server.ts'],
        architecturalStrategy: 'Adopt singleton connection manager with keep-alive',
        stepByStepPlan: [
          {
            stepNumber: 1,
            description: 'Refactor DB client initialization',
            expectedOutcome: 'Pool connection created cleanly'
          },
          {
            stepNumber: 2,
            description: 'Update health check queries',
            expectedOutcome: 'Returns 200 OK on /healthz'
          }
        ],
        verificationStrategy: 'Run npm test db.test.ts',
        rollbackStrategy: 'Git revert commit'
      });

      const markdownText = `Here is the architectural plan:\n\`\`\`json\n${planJson}\n\`\`\`\nPlease review.`;
      const plan = PlanModeDispatcher.parseStructuredPlan(markdownText);

      assert.ok(plan);
      assert.strictEqual(plan.planTitle, 'Database Connection Pool Migration');
      assert.strictEqual(plan.goal, 'Upgrade DB connection pool to avoid socket leaks');
      assert.strictEqual(plan.affectedFiles.length, 2);
      assert.strictEqual(plan.stepByStepPlan.length, 2);
      assert.strictEqual(plan.stepByStepPlan[0].stepNumber, 1);
    });

    it('should return null for non-plan text or malformed JSON', () => {
      assert.strictEqual(PlanModeDispatcher.parseStructuredPlan('plain conversational text without plan'), null);
      assert.strictEqual(PlanModeDispatcher.parseStructuredPlan('```json\n{broken json\n```'), null);
      assert.strictEqual(PlanModeDispatcher.parseStructuredPlan(''), null);
    });
  });
});
