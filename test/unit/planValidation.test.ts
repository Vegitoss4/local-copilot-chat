import * as assert from 'assert';
import { PlanManager, PlanSchemaV1 } from '../../src/services/planSchema';

describe('Phase 9.3: Reliable Planning, Structured Schemas & Validation Suite', () => {
  describe('Fast-Path Trivial Query Router', () => {
    it('should classify greetings, syntax queries, and general explanations as trivial', () => {
      assert.strictEqual(PlanManager.isTrivialQuery('hello'), true);
      assert.strictEqual(PlanManager.isTrivialQuery('how do I parse a date in javascript?'), true);
      assert.strictEqual(PlanManager.isTrivialQuery('what is the difference between let and const'), true);
    });

    it('should classify action/modification queries as non-trivial requiring planning', () => {
      assert.strictEqual(PlanManager.isTrivialQuery('refactor userController to use async/await'), false);
      assert.strictEqual(PlanManager.isTrivialQuery('fix the bug in src/auth.ts'), false);
      assert.strictEqual(PlanManager.isTrivialQuery('create a new unit test suite for payment.ts'), false);
      assert.strictEqual(PlanManager.isTrivialQuery('implement retry logic in ollamaService.ts'), false);
    });
  });

  describe('PlanSchemaV1 Validation', () => {
    it('should validate a compliant plan successfully', () => {
      const validPlan: PlanSchemaV1 = {
        schemaVersion: 1,
        objective: 'Add retry logic to fetch user profile',
        steps: [
          {
            id: '1',
            description: 'Read the existing user service file',
            tool: 'readFile',
            args: { path: 'src/services/userService.ts' },
            dependsOn: [],
            status: 'pending'
          },
          {
            id: '2',
            description: 'Apply retry wrapper patch',
            tool: 'patchFile',
            args: { path: 'src/services/userService.ts', target: 'fetch()', replacement: 'retry(fetch)' },
            dependsOn: ['1'],
            status: 'pending'
          }
        ]
      };

      const res = PlanManager.validatePlan(validPlan);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
      assert.strictEqual(res.plan?.steps.length, 2);
    });

    it('should parse and repair slightly malformed JSON plans via TolerantJsonParser', () => {
      const jsonTextWithTrailingCommas = `
        \`\`\`json
        {
          "schemaVersion": 1,
          "objective": "Fix login bug",
          "steps": [
            {
              "id": "step-1",
              "description": "Read auth file",
              "tool": "readFile",
              "args": { "path": "src/auth.ts" },
              "dependsOn": [],
            },
          ],
        }
        \`\`\`
      `;

      const res = PlanManager.validatePlan(jsonTextWithTrailingCommas);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.plan?.steps[0].id, 'step-1');
    });

    it('should reject plans with unknown tools or invalid forward dependencies', () => {
      const invalidPlan = {
        schemaVersion: 1,
        objective: 'Test invalid dependencies',
        steps: [
          {
            id: 'step-1',
            description: 'Depends on step-2 which has not run yet',
            tool: 'unknownDangerousTool',
            args: {},
            dependsOn: ['step-2'] // forward dependency
          },
          {
            id: 'step-2',
            description: 'Second step',
            tool: 'readFile',
            args: {},
            dependsOn: []
          }
        ]
      };

      const res = PlanManager.validatePlan(invalidPlan);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('unknown tool')));
      assert.ok(res.errors.some(e => e.includes('forward dependency')));
    });

    it('should enforce maximum step cap', () => {
      const excessivePlan = {
        schemaVersion: 1,
        objective: 'Excessive plan',
        steps: Array.from({ length: 15 }, (_, i) => ({
          id: `step-${i}`,
          description: `Step ${i}`,
          tool: 'readFile',
          args: {},
          dependsOn: []
        }))
      };

      const res = PlanManager.validatePlan(excessivePlan);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('maximum allowable step limit')));
    });
  });
});
