const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');
global.fetch = nativeFetch;

const { OllamaService } = require('../../out/services/ollamaService');
const { SwarmOrchestrator } = require('../../out/services/swarmOrchestrator');
const { resetMockState, setMockWorkspaceFolders } = require('../../out-test/test/mocks/vscodeMock.js');

function createFixture(targetDir) {
  const controllerDir = path.join(targetDir, 'Backend.Api', 'Controllers');
  fs.mkdirSync(controllerDir, { recursive: true });
  fs.writeFileSync(
    path.join(controllerDir, 'TaskItemsController.cs'),
    `using Microsoft.AspNetCore.Mvc;\n\n\`\`\`\n[ApiController]\npublic class TaskItemsController : ControllerBase {}\n\`\`\``
  );
}

async function runSmoke(model) {
  console.log(`\n=== RUNNING SMOKE TASK ON: ${model} ===`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-${model.replace(/[:.]/g, '_')}-`));
  createFixture(tempDir);
  const rootUri = vscodeMock.Uri.file(tempDir);
  resetMockState(tempDir);
  setMockWorkspaceFolders([{ uri: rootUri, name: 'smoke-app', index: 0 }]);

  const ollama = new OllamaService('http://127.0.0.1:11434');
  let toolCallsMade = [];

  const orchestrator = new SwarmOrchestrator(ollama, {
    maxTurns: 4,
    numCtx: 4096,
    temperature: 0.2,
    autonomousMode: true,
    userModel: model,
    availableModels: [model],
    workspaceRootUri: rootUri
  });

  const prompt = 'remove the stray ``` lines from Backend.Api/Controllers/TaskItemsController.cs';
  try {
    const res = await orchestrator.runTask(prompt, {
      onToolStart: (c) => toolCallsMade.push(c.function.name)
    }, AbortSignal.timeout(60000));
  } catch (err) {
    console.log(`Smoke run error: ${err.message}`);
  }

  const filePath = path.join(tempDir, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
  const fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const fencesRemoved = !fileContent.includes('```');

  console.log(`Model: ${model}`);
  console.log(`Tool calls made: [${toolCallsMade.join(', ')}]`);
  console.log(`Fences removed: ${fencesRemoved}`);
  console.log(`Smoke task outcome: ${fencesRemoved ? 'PASS' : 'FAIL'}`);

  fs.rmSync(tempDir, { recursive: true, force: true });
  return { model, toolCallsMade, fencesRemoved, pass: fencesRemoved };
}

async function main() {
  const res7b = await runSmoke('qwen2.5-coder:7b');
  const res9b = await runSmoke('qwen3.5:9b');
  console.log('\n=== SMOKE TEST RESULTS SUMMARY ===');
  console.log(JSON.stringify([res7b, res9b], null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
