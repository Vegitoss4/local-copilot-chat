import * as assert from 'assert';
import { ExploreBeforeAskGate } from '../../src/services/exploreBeforeAskGate';
import { ExtensionLogger } from '../../src/services/extensionLogger';
import { WorkspaceDiscoveryResult } from '../../src/services/workspaceDiscoveryService';

describe('Scoped Fix: ExploreBeforeAskGate & Question Budget Suite', () => {
  let mockDiscovery: WorkspaceDiscoveryResult;

  beforeEach(() => {
    mockDiscovery = {
      rawText: '<untrusted_workspace_discovery>Sample</untrusted_workspace_discovery>',
      detectedStacks: ['ASP.NET Core / .NET', 'Angular', 'TypeScript'],
      manifestFiles: ['Backend.Api/Backend.Api.csproj', 'Frontend.Client/package.json'],
      keyEntryFilesPresent: ['Program.cs'],
      keyEntryFilesMissing: [],
      hasRelevantFiles: true,
      totalFilesDiscovered: 15,
      gitBranch: 'main',
      truncatedFilesCount: 0,
      truncatedFiles: [],
    };
  });

  it('should reject ask_user when distinct exploration calls are below threshold', () => {
    const gate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: 3,
      discoveryResult: mockDiscovery,
      hasRelevantFiles: true,
      hasToolSupport: true,
    });

    const res = gate.evaluateAskUser('Which database should we use?');
    assert.strictEqual(res.allowed, false);
    assert.ok(res.reason?.includes('Inspect the workspace first'));
    assert.strictEqual(gate.getTaskRejectionsCount(), 1);
  });

  it('should only count DISTINCT exploration calls and reject repeated calls to same target', () => {
    const gate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: 3,
      discoveryResult: mockDiscovery,
    });

    // Spam the exact same tool and path
    gate.recordToolCall('list_dir', { path: '.' }, true);
    gate.recordToolCall('list_dir', { path: '.' }, true);
    gate.recordToolCall('list_dir', { path: '.' }, true);

    assert.strictEqual(gate.getDistinctExplorationCount(), 1);
    const evalRes1 = gate.evaluateAskUser('Should I proceed?');
    assert.strictEqual(evalRes1.allowed, false, 'Spamming same call should not satisfy exploration threshold');

    // Make 2 genuinely distinct calls
    gate.recordToolCall('list_dir', { path: 'Backend.Api' }, true);
    gate.recordToolCall('view_file_range', { path: 'Backend.Api/Program.cs', start_line: 1, end_line: 20 }, true);

    assert.strictEqual(gate.getDistinctExplorationCount(), 3);
    const evalRes2 = gate.evaluateAskUser('Which API port do you prefer between 5000 and 7041?');
    assert.strictEqual(evalRes2.allowed, true, 'Distinct calls should satisfy gate threshold');
  });

  it('should trigger deadlock escape hatch after 2 rejections and allow question through', () => {
    const gate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: 3,
      discoveryResult: mockDiscovery,
    });

    const res1 = gate.evaluateAskUser('Question 1');
    assert.strictEqual(res1.allowed, false);
    assert.strictEqual(gate.getTaskRejectionsCount(), 1);

    const res2 = gate.evaluateAskUser('Question 2');
    assert.strictEqual(res2.allowed, false);
    assert.strictEqual(gate.getTaskRejectionsCount(), 2);

    // Third attempt: escape hatch triggers
    const res3 = gate.evaluateAskUser('Question 3');
    assert.strictEqual(res3.allowed, true);
    assert.strictEqual(res3.escapeHatchTriggered, true);
  });

  it('should skip gate immediately when discovery found no relevant files', () => {
    const gate = new ExploreBeforeAskGate({
      hasRelevantFiles: false,
    });

    const res = gate.evaluateAskUser('No files found, where should we begin?');
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.escapeHatchTriggered, true);
  });

  it('should skip gate when model lacks tool support or experiences repeated failures', () => {
    const noToolsGate = new ExploreBeforeAskGate({
      hasToolSupport: false,
    });

    const res1 = noToolsGate.evaluateAskUser('What framework?');
    assert.strictEqual(res1.allowed, true);
    assert.strictEqual(res1.escapeHatchTriggered, true);

    const failGate = new ExploreBeforeAskGate({
      hasToolSupport: true,
      minExplorationBeforeAsk: 3,
    });
    failGate.recordToolCall('list_dir', { path: '.' }, false);
    failGate.recordToolCall('list_dir', { path: '.' }, false);
    failGate.recordToolCall('list_dir', { path: '.' }, false);

    const res2 = failGate.evaluateAskUser('What should we do?');
    assert.strictEqual(res2.allowed, true, 'Repeated tool failures should open escape hatch');
    assert.strictEqual(res2.escapeHatchTriggered, true);
  });

  it('should reject redundant fact questions advisory once, then allow on second attempt', () => {
    const gate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: 0, // exploration requirement met
      discoveryResult: mockDiscovery,
    });

    // Question asks about backend framework already identified as ASP.NET Core
    const res1 = gate.evaluateAskUser('What backend framework is being used?');
    assert.strictEqual(res1.allowed, false);
    assert.strictEqual(res1.isAdvisory, true);
    assert.ok(res1.reason?.includes('already identified ASP.NET Core'));

    // Second identical question: advisory check allows to prevent false-positive freeze
    const res2 = gate.evaluateAskUser('What backend framework is being used?');
    assert.strictEqual(res2.allowed, true);
  });

  it('should enforce clarification question budget cap per task', () => {
    const gate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: 0,
      maxClarificationQuestionsPerTask: 2,
    });

    const res1 = gate.evaluateAskUser('Valid specific question 1: Port preference?');
    assert.strictEqual(res1.allowed, true);
    assert.strictEqual(gate.getClarificationQuestionsCount(), 1);

    const res2 = gate.evaluateAskUser('Valid specific question 2: SQLite or SQL Server?');
    assert.strictEqual(res2.allowed, true);
    assert.strictEqual(gate.getClarificationQuestionsCount(), 2);

    const res3 = gate.evaluateAskUser('Question 3 exceeding cap');
    assert.strictEqual(res3.allowed, false);
    assert.ok(res3.reason?.includes('Clarification question limit reached'));
  });

  it('should require distinct exploration before allowing question when key entry files are missing ("angular is partially implemented")', () => {
    // Fixture discovery result where angular is partially implemented (manifest exists, but angular.json & main.ts missing)
    const partialAngularDiscovery: WorkspaceDiscoveryResult = {
      rawText: 'Frontend.Client has package.json with @angular/core, but angular.json and src/main.ts are missing',
      detectedStacks: ['angular', 'dotnet'],
      manifestFiles: ['Frontend.Client/package.json', 'Backend.Api/Backend.Api.csproj'],
      keyEntryFilesPresent: ['Frontend.Client/package.json'],
      keyEntryFilesMissing: ['Frontend.Client/angular.json', 'Frontend.Client/src/main.ts'],
      hasRelevantFiles: true,
      totalFilesDiscovered: 15,
      truncatedFilesCount: 0,
      truncatedFiles: []
    };

    const gate = new ExploreBeforeAskGate({
      minExplorationBeforeAsk: 3,
      maxClarificationQuestionsPerTask: 2,
      hasRelevantFiles: true,
      hasToolSupport: true,
      discoveryResult: partialAngularDiscovery
    });

    // Model attempts to immediately ask about the missing files without exploring
    const initialAsk = gate.evaluateAskUser('Should I create angular.json using standalone or NgModule bootstrap?');
    assert.strictEqual(initialAsk.allowed, false, 'Gate must block ask_user before minimum distinct explorations');
    assert.ok(initialAsk.reason?.includes('Inspect the workspace first: use read tools'));

    // Perform only 1 distinct exploration
    gate.recordToolCall('view_file_range', { filePath: 'Frontend.Client/package.json', startLine: 1, endLine: 20 }, true);
    assert.strictEqual(gate.getDistinctExplorationCount(), 1);

    const secondAsk = gate.evaluateAskUser('Should I create angular.json using standalone or NgModule bootstrap?');
    assert.strictEqual(secondAsk.allowed, false, 'Gate must continue blocking after only 1 exploration');

    // Perform 2 more distinct explorations (meeting min quota of 3)
    gate.recordToolCall('list_dir', { dirPath: 'Frontend.Client/src' }, true);
    gate.recordToolCall('search_workspace', { query: 'bootstrapApplication' }, true);
    assert.strictEqual(gate.getDistinctExplorationCount(), 3);

    // Now question is permitted
    const permittedAsk = gate.evaluateAskUser('Should I create angular.json using standalone or NgModule bootstrap?');
    assert.strictEqual(permittedAsk.allowed, true, 'Gate must allow question after satisfying exploration quota');
  });
});
