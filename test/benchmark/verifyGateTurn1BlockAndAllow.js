const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');
global.fetch = nativeFetch;
const fs = require('fs');
const path = require('path');
const { ExploreBeforeAskGate } = require('../../out/services/exploreBeforeAskGate.js');
const { SwarmOrchestrator } = require('../../out/services/swarmOrchestrator.js');

function runGateCheck() {
  console.log('=== VERIFYING EXPLORE-BEFORE-ASK GATE: TURN 1 BLOCK THEN ALLOW ===\n');

  const gate = new ExploreBeforeAskGate({
    minExplorationBeforeAsk: 3,
    maxClarificationQuestionsPerTask: 2,
    hasRelevantFiles: true,
    hasToolSupport: true,
    generationId: 'test_gen_turn1_gate',
    discoveryResult: {
      rawText: 'Discovery',
      detectedStacks: ['ASP.NET Core'],
      manifestFiles: ['Backend.Api.csproj'],
      keyEntryFilesPresent: ['Program.cs'],
      keyEntryFilesMissing: [],
      hasRelevantFiles: true,
      totalFilesDiscovered: 5,
      gitBranch: 'main',
      truncatedFilesCount: 0,
      truncatedFiles: []
    }
  });

  const log = [];

  // Turn 1: Attempt ask_user without exploration
  console.log('[Turn 1] Model emits tool call: ask_user("Which port should I configure?")');
  const turn1Decision = gate.evaluateAskUser('Which port should I configure?');
  log.push({
    turn: 1,
    action: 'ask_user',
    allowed: turn1Decision.allowed,
    reason: turn1Decision.reason,
    explanation: turn1Decision.message
  });
  console.log(`  Decision: Allowed=${turn1Decision.allowed} | Reason=${turn1Decision.reason}`);
  console.log(`  Gate Response: "${turn1Decision.message}"\n`);

  if (turn1Decision.allowed) {
    throw new Error('GATE FAILURE: Turn 1 ask_user should have been BLOCKED!');
  }

  // Turn 2: Distinct read exploration call 1
  console.log('[Turn 2] Model emits exploration: list_dir("Backend.Api")');
  gate.recordToolCall('list_dir', { path: 'Backend.Api' }, true);
  console.log(`  Distinct exploration count: ${gate.getDistinctExplorationCount()} / 3\n`);

  // Turn 3: Distinct read exploration call 2
  console.log('[Turn 3] Model emits exploration: view_file_range("Backend.Api/Controllers/TaskItemsController.cs", 1, 50)');
  gate.recordToolCall('view_file_range', { filePath: 'Backend.Api/Controllers/TaskItemsController.cs', startLine: 1, endLine: 50 }, true);
  console.log(`  Distinct exploration count: ${gate.getDistinctExplorationCount()} / 3\n`);

  // Turn 4: Distinct read exploration call 3
  console.log('[Turn 4] Model emits exploration: search_workspace("TaskItem")');
  gate.recordToolCall('search_workspace', { query: 'TaskItem' }, true);
  console.log(`  Distinct exploration count: ${gate.getDistinctExplorationCount()} / 3 (Quota Met!)\n`);

  // Turn 5: Model attempts ask_user again after quota met
  console.log('[Turn 5] Model emits tool call: ask_user("Which port should I configure?")');
  const turn5Decision = gate.evaluateAskUser('Which port should I configure?');
  log.push({
    turn: 5,
    action: 'ask_user',
    allowed: turn5Decision.allowed,
    reason: turn5Decision.reason,
    explanation: turn5Decision.message || 'Allowed by exploration quota'
  });
  console.log(`  Decision: Allowed=${turn5Decision.allowed} | Reason=${turn5Decision.reason}`);
  console.log(`  Gate Response: "${turn5Decision.message || 'Allowed by exploration quota'}"\n`);

  if (!turn5Decision.allowed) {
    throw new Error('GATE FAILURE: Turn 5 ask_user should have been ALLOWED!');
  }

  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'gate_turn1_block_allow_evidence.json');
  fs.writeFileSync(outPath, JSON.stringify({ log, passed: true }, null, 2), 'utf8');
  console.log(`=== GATE EVIDENCE RECORDED IN: ${outPath} ===\n`);
}

runGateCheck();
