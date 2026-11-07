import * as assert from 'assert';
import { TypedAgentContracts } from '../../src/services/typedAgentContracts';

describe('Phase 10.4: Specialized Agent Roles & Typed Contracts Suite', () => {
  it('should validate ArchitectOutput from structured JSON or raw LLM output', () => {
    const raw = `
      \`\`\`json
      {
        "role": "architect",
        "objective": "Add caching layer",
        "architecturePlan": ["Create SimpleLRU", "Wrap userService"],
        "filesToModify": ["src/cache.ts", "src/user.ts"],
        "rationale": "High latency on user calls"
      }
      \`\`\`
    `;

    const parsed = TypedAgentContracts.parseArchitectOutput(raw);
    assert.strictEqual(parsed.role, 'architect');
    assert.strictEqual(parsed.architecturePlan.length, 2);
    assert.strictEqual(parsed.filesToModify.length, 2);
    assert.strictEqual(parsed.rationale, 'High latency on user calls');
  });

  it('should validate DeveloperOutput with surgical patches', () => {
    const raw = {
      role: 'developer',
      patches: [
        { filePath: 'src/app.ts', target: 'const a = 1;', replacement: 'const a = 2;' }
      ],
      explanation: 'Updated constant'
    };

    const parsed = TypedAgentContracts.parseDeveloperOutput(raw);
    assert.strictEqual(parsed.role, 'developer');
    assert.strictEqual(parsed.patches.length, 1);
    assert.strictEqual(parsed.patches[0].filePath, 'src/app.ts');
  });

  it('should reject invalid DeveloperOutput with missing target', () => {
    const invalid = {
      role: 'developer',
      patches: [{ filePath: 'src/app.ts', replacement: 'foo' }]
    };

    assert.throws(() => {
      TypedAgentContracts.parseDeveloperOutput(invalid);
    }, /missing string "target"/);
  });

  it('should validate TesterOutput and ReviewerOutput', () => {
    const testerJson = '{"passed": true, "testCommandsRun": ["npm test"]}';
    const testerRes = TypedAgentContracts.parseTesterOutput(testerJson);
    assert.strictEqual(testerRes.passed, true);
    assert.strictEqual(testerRes.failedCount, 0);

    const reviewerJson = '{"decision": "APPROVED", "qualityScore": 95}';
    const reviewerRes = TypedAgentContracts.parseReviewerOutput(reviewerJson);
    assert.strictEqual(reviewerRes.decision, 'APPROVED');
    assert.strictEqual(reviewerRes.qualityScore, 95);
  });

  it('should validate SecurityAuditorOutput with threat level', () => {
    const secJson = '{"clean": false, "violations": ["Secret detected in config"], "threatLevel": "critical"}';
    const secRes = TypedAgentContracts.parseSecurityOutput(secJson);
    assert.strictEqual(secRes.clean, false);
    assert.strictEqual(secRes.threatLevel, 'critical');
    assert.strictEqual(secRes.violations.length, 1);
  });
});
