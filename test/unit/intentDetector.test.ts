import * as assert from 'assert';
import { IntentDetector } from '../../src/services/intentDetector';

describe('Deliverable 1 & B: Intent Detection Suite', () => {
  describe('Direct Action Commands', () => {
    it('should detect edit intent for "implement TaskItemsController"', () => {
      const res = IntentDetector.detectEditIntent('implement the TaskItemsController in Backend.Api');
      assert.strictEqual(res.hasEditIntent, true);
      assert.ok(res.reason?.includes('implement'));
    });

    it('should detect edit intent for "fix the bug in Program.cs"', () => {
      const res = IntentDetector.detectEditIntent('fix the bug causing CS1056 in TaskItemsController.cs');
      assert.strictEqual(res.hasEditIntent, true);
    });

    it('should detect edit intent for "create new model file"', () => {
      const res = IntentDetector.detectEditIntent('create a new TaskItem model file in Models');
      assert.strictEqual(res.hasEditIntent, true);
    });

    it('should detect edit intent for "update the files to match ports"', () => {
      const res = IntentDetector.detectEditIntent('update the files so the ports match');
      assert.strictEqual(res.hasEditIntent, true);
    });

    it('should detect edit intent for "scaffold angular frontend"', () => {
      const res = IntentDetector.detectEditIntent('scaffold the Angular frontend client');
      assert.strictEqual(res.hasEditIntent, true);
    });
  });

  describe('Referential Triggers with Conversation Context', () => {
    const assistantTurnWithCode = `Here are the steps to fix the issues:
1. Initialize Angular project:
\`\`\`bash
ng new src/app
\`\`\`
2. Update environment:
\`\`\`typescript
export const environment = { apiUrl: 'https://localhost:7041' };
\`\`\``;

    it('should detect edit intent for "fix it" when previous turn contains actionable guidance', () => {
      const res = IntentDetector.detectEditIntent('fix it', assistantTurnWithCode);
      assert.strictEqual(res.hasEditIntent, true);
      assert.strictEqual(res.isReferential, true);
    });

    it('should detect edit intent for "do those" with previous assistant guidance', () => {
      const res = IntentDetector.detectEditIntent('do those', assistantTurnWithCode);
      assert.strictEqual(res.hasEditIntent, true);
      assert.strictEqual(res.isReferential, true);
    });

    it('should detect edit intent for "implement those"', () => {
      const res = IntentDetector.detectEditIntent('implement those', assistantTurnWithCode);
      assert.strictEqual(res.hasEditIntent, true);
      assert.strictEqual(res.isReferential, true);
    });

    it('should detect edit intent for "apply changes"', () => {
      const res = IntentDetector.detectEditIntent('apply the changes', assistantTurnWithCode);
      assert.strictEqual(res.hasEditIntent, true);
      assert.strictEqual(res.isReferential, true);
    });
  });

  describe('Anti-False-Positive Question Filtering', () => {
    it('should NOT trigger edit intent for "how do I fix this?"', () => {
      const res = IntentDetector.detectEditIntent('how do I fix this build error?');
      assert.strictEqual(res.hasEditIntent, false);
      assert.ok(res.reason?.includes('Informational'));
    });

    it('should NOT trigger edit intent for "explain this function"', () => {
      const res = IntentDetector.detectEditIntent('explain how this TaskItemsController works');
      assert.strictEqual(res.hasEditIntent, false);
      assert.ok(res.reason?.includes('Informational'));
    });

    it('should NOT trigger edit intent for "why is the build failing?"', () => {
      const res = IntentDetector.detectEditIntent('why is the dotnet build failing with CS1056?');
      assert.strictEqual(res.hasEditIntent, false);
    });

    it('should NOT trigger edit intent for "what does this error mean?"', () => {
      const res = IntentDetector.detectEditIntent('what does CS1056 unexpected character mean?');
      assert.strictEqual(res.hasEditIntent, false);
    });

    it('should NOT trigger edit intent for casual conversation or greetings', () => {
      const res1 = IntentDetector.detectEditIntent('hello');
      const res2 = IntentDetector.detectEditIntent('good morning');
      assert.strictEqual(res1.hasEditIntent, false);
      assert.strictEqual(res2.hasEditIntent, false);
    });
  });
});
