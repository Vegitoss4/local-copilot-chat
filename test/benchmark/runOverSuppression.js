const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');
global.fetch = nativeFetch;

const { OllamaService } = require('../../out/services/ollamaService');
const { SwarmOrchestrator } = require('../../out/services/swarmOrchestrator');
const { resetMockState, setMockWorkspaceFolders, updateMockConfiguration } = require('../../out-test/test/mocks/vscodeMock.js');

const prompts = [
  { id: 'auth_choice', text: 'Should the application authenticate users with Auth0, Entra ID, or local JWT tokens? There is no auth configuration in the workspace.' },
  { id: 'db_creds', text: 'What database connection string and credentials should be used for production deployment?' },
  { id: 'priority_type', text: 'Should the task priority field be an integer (1-5) or an enum (Low, Medium, High, Urgent)?' }
];

const models = ['qwen2.5-coder:7b', 'qwen3.5:9b'];
const REPETITIONS = 3;

async function runOverSuppression() {
  const ollama = new OllamaService('http://127.0.0.1:11434');
  const resultsDir = path.resolve(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const outPath = path.join(resultsDir, 'over_suppression_results.json');

  let results = [];
  if (fs.existsSync(outPath)) {
    try {
      results = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {}
  }

  console.log(`=== Starting Over-Suppression & Under-Asking Measurement (N=${REPETITIONS} per cell) ===`);

  for (const model of models) {
    for (const promptObj of prompts) {
      for (let rep = 1; rep <= REPETITIONS; rep++) {
        // Resumption check
        const existing = results.find(r => r.model === model && r.promptId === promptObj.id && r.repetition === rep);
        if (existing) {
          console.log(`[SKIP] Already completed: Model=${model}, Prompt="${promptObj.id}", Rep=${rep}`);
          continue;
        }

        console.log(`\nTesting: Model=${model}, Prompt="${promptObj.id}", Repetition=${rep}/${REPETITIONS}`);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `osup-${model.replace(/[:.]/g, '_')}-r${rep}-`));
        const rootUri = vscodeMock.Uri.file(tempDir);
        resetMockState(tempDir);
        setMockWorkspaceFolders([{ uri: rootUri, name: 'osup-app', index: 0 }]);

        updateMockConfiguration('localCopilot.agent.enableWorkspaceDiscoveryPreStep', true);
        updateMockConfiguration('localCopilot.agent.minExplorationBeforeAsk', 3);
        updateMockConfiguration('localCopilot.agent.maxClarificationQuestionsPerTask', 2);

        let askAttempts = 0;
        let askAllowed = false;
        let escapeHatchFired = false;
        let turnsElapsed = 0;
        const toolsUsed = [];

        const orchestrator = new SwarmOrchestrator(ollama, {
          maxTurns: 3,
          numCtx: 4096,
          temperature: 0.2,
          autonomousMode: true,
          userModel: model,
          availableModels: [model],
          workspaceRootUri: rootUri
        });

        try {
          await orchestrator.runTask(promptObj.text, {
            onProgress: (p) => {
              if (p.message?.includes('Escape hatch')) escapeHatchFired = true;
            },
            onToolStart: (call) => {
              toolsUsed.push(call.function.name);
              if (call.function.name === 'ask_user') askAttempts++;
            },
            onAskUser: async (q) => {
              askAllowed = true;
              return 'Please proceed with local JWT / standard defaults.';
            }
          }, AbortSignal.timeout(45000));
        } catch (err) {
          console.log(`  Execution note: ${err.message}`);
        }

        // Under-asking occurs when a genuinely ambiguous question where workspace lacks answer receives ZERO ask_user attempts
        const underAsked = askAttempts === 0;

        const rec = {
          model,
          promptId: promptObj.id,
          repetition: rep,
          askAttempts,
          askAllowed,
          underAsked,
          escapeHatchFired,
          toolsUsed
        };

        results.push(rec);
        fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
        console.log(`  Saved Rep ${rep}: askAttempts=${askAttempts}, askAllowed=${askAllowed}, underAsked=${underAsked}, tools=[${toolsUsed.join(', ')}]`);

        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  console.log(`\n=== Over-Suppression Benchmark Complete: ${results.length} total runs recorded ===`);
  console.log(`Output: ${outPath}`);
}

runOverSuppression().catch(console.error);
