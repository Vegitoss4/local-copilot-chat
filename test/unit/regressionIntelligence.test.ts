import * as assert from 'assert';
import * as path from 'path';
import { RegressionIntelligenceService } from '../../src/services/regressionIntelligenceService';

describe('Phase 6.6: Regression Intelligence & Targeted Test Selection Suite', () => {
  let regressionService: RegressionIntelligenceService;

  beforeEach(() => {
    regressionService = new RegressionIntelligenceService();
    // Register available workspace tests
    regressionService.registerTestFile('C:/Projects/app/test/unit/auth.test.ts');
    regressionService.registerTestFile('C:/Projects/app/test/unit/user.test.ts');
    regressionService.registerTestFile('C:/Projects/app/test/unit/billing.test.ts');
    regressionService.registerTestFile(
      'C:/Projects/app/test/integration/api.test.ts',
      ['C:/Projects/app/src/network.ts', 'C:/Projects/app/src/client.ts']
    );
  });

  afterEach(() => {
    regressionService.clear();
  });

  it('should select test file by naming convention when source file is modified', () => {
    const result = regressionService.selectTargetedTests(['C:/Projects/app/src/auth.ts']);

    assert.strictEqual(result.requiresFullSuite, false);
    assert.strictEqual(result.affectedTestFiles.length, 1);
    assert.strictEqual(
      result.affectedTestFiles[0].toLowerCase(),
      path.normalize('C:/Projects/app/test/unit/auth.test.ts').toLowerCase()
    );
    assert.ok(result.recommendedCommand?.includes('auth.test.ts'));
  });

  it('should select test file by imported source dependency mapping', () => {
    const result = regressionService.selectTargetedTests(['C:/Projects/app/src/network.ts']);

    assert.strictEqual(result.requiresFullSuite, false);
    assert.strictEqual(result.affectedTestFiles.length, 1);
    assert.strictEqual(
      result.affectedTestFiles[0].toLowerCase(),
      path.normalize('C:/Projects/app/test/integration/api.test.ts').toLowerCase()
    );
    assert.ok(result.recommendedCommand?.includes('api.test.ts'));
  });

  it('should select test file directly when the test itself is modified', () => {
    const result = regressionService.selectTargetedTests(['C:/Projects/app/test/unit/billing.test.ts']);

    assert.strictEqual(result.requiresFullSuite, false);
    assert.strictEqual(result.affectedTestFiles.length, 1);
    assert.strictEqual(
      result.affectedTestFiles[0].toLowerCase(),
      path.normalize('C:/Projects/app/test/unit/billing.test.ts').toLowerCase()
    );
  });

  it('should escalate to full test suite when core configuration or shared types change', () => {
    const pkgResult = regressionService.selectTargetedTests(['C:/Projects/app/package.json']);
    assert.strictEqual(pkgResult.requiresFullSuite, true);
    assert.strictEqual(pkgResult.recommendedCommand, 'npm test');
    assert.ok(pkgResult.reason.includes('package.json'));

    const tsConfigResult = regressionService.selectTargetedTests(['C:/Projects/app/tsconfig.json']);
    assert.strictEqual(tsConfigResult.requiresFullSuite, true);
    assert.strictEqual(tsConfigResult.recommendedCommand, 'npm test');
  });

  it('should return empty results gracefully when no files are modified', () => {
    const result = regressionService.selectTargetedTests([]);
    assert.strictEqual(result.affectedTestFiles.length, 0);
    assert.strictEqual(result.requiresFullSuite, false);
    assert.strictEqual(result.recommendedCommand, undefined);
  });

  it('should traverse transitive callers to identify affected tests', () => {
    // network.ts imports http_core.ts; api.test.ts imports network.ts
    regressionService.registerSourceDependency(
      'C:/Projects/app/src/network.ts',
      'C:/Projects/app/src/http_core.ts'
    );

    const result = regressionService.selectTargetedTests(['C:/Projects/app/src/http_core.ts']);
    assert.strictEqual(result.requiresFullSuite, false);
    assert.strictEqual(result.affectedTestFiles.length, 1);
    assert.strictEqual(
      result.affectedTestFiles[0].toLowerCase(),
      path.normalize('C:/Projects/app/test/integration/api.test.ts').toLowerCase()
    );
  });

  it('should escalate to full test suite when modified file has no associated tests', () => {
    const result = regressionService.selectTargetedTests(['C:/Projects/app/src/legacy_unknown.ts']);
    assert.strictEqual(result.requiresFullSuite, true);
    assert.strictEqual(result.recommendedCommand, 'npm test');
    assert.ok(result.reason.includes('Escalating to full test suite'));
  });
});
