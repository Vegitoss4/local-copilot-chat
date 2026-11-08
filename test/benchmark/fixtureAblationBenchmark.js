const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');

// Enable live network for real Ollama
global.fetch = nativeFetch;

const { OllamaService } = require('../../out/services/ollamaService');
const { SwarmOrchestrator } = require('../../out/services/swarmOrchestrator');
const { WorkspaceDiscoveryService } = require('../../out/services/workspaceDiscoveryService');
const { ExploreBeforeAskGate } = require('../../out/services/exploreBeforeAskGate');
const { OrchestratorAgent } = require('../../out/services/agentRegistry');
const { resetMockState, setMockWorkspaceFolders, updateMockConfiguration } = require('../../out-test/test/mocks/vscodeMock.js');

// =========================================================================
// METRIC DEFINITIONS
// =========================================================================
// (i) firstTurnAskRate: Orchestrator's first turn calls ask_user OR emits clarification text with no tool call.
// (ii) clarificationAllowedRate: Proportion of attempted ask_user calls allowed through by gate (allowed / attempted, <= 100%).
// (iii) turnsToFirstWrite: Step count until first file modification tool (str_replace, create_file, apply_patch, etc.).
// (iv) taskOutcome: Strict objective pass requiring:
//     - fencesRemoved: no stray ``` in TaskItemsController.cs
//     - idTypesAligned: no Guid id mismatch
//     - propertyNamesAligned: no .Completed vs .IsCompleted mismatch
//     - portsAligned: frontend port 7041 aligned with launchSettings
//     - dotnetBuildExitZero: dotnet build Backend.Api.csproj returns 0
// =========================================================================

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const NUM_CTX = 8192;
const TEMPERATURE = 0.2;
const SEEDS = [42, 101];
const MAX_TURNS = 12;

const OLD_RULE_8 = `8. If the user's requirements are ambiguous or you need architectural direction, use 'ask_user' to pause and ask the developer.`;
const NEW_RULE_8 = `8. NEVER call ask_user or ask the user for architectural or framework choices before thoroughly inspecting the workspace. Always inspect existing manifests, configuration, and code files first using read-only exploration tools. Only invoke ask_user when a decision cannot be deduced from existing workspace files (e.g. choosing between two mutually exclusive design options when no existing code indicates a preference). If the user asks a question or makes an architectural statement without an explicit edit instruction, investigate the workspace, report what you find, and propose concrete next steps.`;

function getHardwareFingerprint() {
  try {
    return cp.execSync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader', { encoding: 'utf-8' }).trim();
  } catch {
    return 'NVIDIA GPU (nvidia-smi query unavailable)';
  }
}

function getDotnetVersion() {
  try {
    return cp.execSync('dotnet --version', { encoding: 'utf-8' }).trim();
  } catch {
    return 'CANNOT VERIFY HERE';
  }
}

function createSyntheticProjectFixture(targetDir) {
  const backendDir = path.join(targetDir, 'Backend.Api');
  const controllerDir = path.join(backendDir, 'Controllers');
  const modelsDir = path.join(backendDir, 'Models');
  const propsDir = path.join(backendDir, 'Properties');

  const frontendDir = path.join(targetDir, 'Frontend.Client');
  const appDir = path.join(frontendDir, 'src', 'app');
  const servicesDir = path.join(appDir, 'services');
  const feModelsDir = path.join(appDir, 'models');

  fs.mkdirSync(controllerDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(propsDir, { recursive: true });
  fs.mkdirSync(servicesDir, { recursive: true });
  fs.mkdirSync(feModelsDir, { recursive: true });

  // Deep Angular feature tree (5 levels deep)
  const deepTree = path.join(appDir, 'features', 'tasks', 'components', 'task-list', 'subcomponents');
  fs.mkdirSync(deepTree, { recursive: true });
  for (let i = 1; i <= 20; i++) {
    fs.writeFileSync(path.join(deepTree, `task-item-${i}.component.ts`), `export class TaskItem${i}Component {}`);
    fs.writeFileSync(path.join(deepTree, `task-item-${i}.component.html`), `<div>Task ${i}</div>`);
  }

  // 1. Backend Project
  fs.writeFileSync(
    path.join(backendDir, 'Backend.Api.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>`
  );

  fs.writeFileSync(
    path.join(backendDir, 'Program.cs'),
    `var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddControllers();\nvar app = builder.Build();\napp.MapControllers();\napp.Run();`
  );

  fs.writeFileSync(
    path.join(modelsDir, 'TaskItem.cs'),
    `namespace Backend.Api.Models;\n\npublic class TaskItem {\n    public int Id { get; set; }\n    public string Title { get; set; } = string.Empty;\n    public string? Description { get; set; }\n    public bool IsCompleted { get; set; }\n    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;\n}`
  );

  fs.writeFileSync(
    path.join(controllerDir, 'TaskItemsController.cs'),
    `using Microsoft.AspNetCore.Mvc;\nusing Backend.Api.Models;\n\nnamespace Backend.Api.Controllers;\n\n\`\`\`\n[ApiController]\n[Route("api/[controller]")]\npublic class TaskItemsController : ControllerBase {\n    private static readonly List<TaskItem> _tasks = new();\n\n    [HttpGet("{id:guid}")]\n    public IActionResult GetById(Guid id) {\n        var item = _tasks.FirstOrDefault(t => t.Id == 1);\n        if (item == null) return NotFound();\n        return Ok(item);\n    }\n\n    [HttpPut("{id:guid}")]\n    public IActionResult Update(Guid id, [FromBody] TaskItem updated) {\n        var existing = _tasks.FirstOrDefault(t => t.Id == 1);\n        if (existing == null) return NotFound();\n        existing.Title = updated.Title;\n        existing.Completed = updated.IsCompleted;\n        return NoContent();\n    }\n}\n\`\`\``
  );

  fs.writeFileSync(
    path.join(propsDir, 'launchSettings.json'),
    JSON.stringify({
      profiles: {
        "Backend.Api": {
          commandName: "Project",
          applicationUrl: "https://localhost:7041;http://localhost:5041"
        }
      }
    }, null, 2)
  );

  // 2. Frontend files
  fs.writeFileSync(
    path.join(feModelsDir, 'taskitem.model.ts'),
    `export interface TaskItem {\n  id?: number;\n  title: string;\n  description?: string;\n  isCompleted: boolean;\n}`
  );

  fs.writeFileSync(
    path.join(servicesDir, 'taskitem.service.ts'),
    `export class TaskItemService {\n  private apiUrl = 'https://localhost:7001/api/taskitems'; // Port mismatch\n}`
  );
}

function evaluateDetailedOutcome(workspaceDir) {
  const controllerPath = path.join(workspaceDir, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
  const servicePath = path.join(workspaceDir, 'Frontend.Client', 'src', 'app', 'services', 'taskitem.service.ts');

  let fencesRemoved = false;
  let idTypesAligned = false;
  let propertyNamesAligned = false;
  let portsAligned = false;
  let dotnetBuildExitZero = false;

  if (fs.existsSync(controllerPath)) {
    const content = fs.readFileSync(controllerPath, 'utf-8');
    fencesRemoved = !content.includes('```');
    idTypesAligned = !content.includes('Guid id');
    propertyNamesAligned = !content.includes('.Completed =');
  }

  if (fs.existsSync(servicePath)) {
    const sContent = fs.readFileSync(servicePath, 'utf-8');
    portsAligned = sContent.includes('7041');
  }

  const buildRes = cp.spawnSync('dotnet', ['build', path.join(workspaceDir, 'Backend.Api', 'Backend.Api.csproj')], {
    encoding: 'utf-8',
    timeout: 30000
  });
  dotnetBuildExitZero = buildRes.status === 0;

  const overallPass = fencesRemoved && idTypesAligned && propertyNamesAligned && portsAligned && dotnetBuildExitZero;
  return { fencesRemoved, idTypesAligned, propertyNamesAligned, portsAligned, dotnetBuildExitZero, overallPass };
}

async function runBenchmark() {
  const ollama = new OllamaService(OLLAMA_ENDPOINT);

  console.log('=== UNIFIED 4-CONDITION A/B BENCHMARK HARNESS ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Ollama Endpoint: ${OLLAMA_ENDPOINT}`);
  console.log(`Hardware Fingerprint: ${getHardwareFingerprint()}`);
  console.log(`dotnet CLI: ${getDotnetVersion()}`);
  console.log(`Params: numCtx=${NUM_CTX}, temp=${TEMPERATURE}, seeds=[${SEEDS.join(', ')}], maxTurns=${MAX_TURNS}`);

  // 1. Audit Discovery Caps on synthetic realistic fixture
  console.log('\n--- 1. AUDITING DISCOVERY CAPS WITH PRUNED SUBTREES ---');
  const auditTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixture-'));
  createSyntheticProjectFixture(auditTempDir);
  const auditRootUri = vscodeMock.Uri.file(auditTempDir);
  resetMockState(auditTempDir);
  setMockWorkspaceFolders([{ uri: auditRootUri, name: 'audit-app', index: 0 }]);

  vscodeMock.workspace.fs = {
    async createDirectory(uri) { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
    async readDirectory(uri) {
      const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map(e => [e.name, e.isDirectory() ? 2 : 1]);
    },
    async readFile(uri) { return new Uint8Array(await fs.promises.readFile(uri.fsPath)); },
    async writeFile(uri, content) {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, Buffer.from(content));
    },
    async stat(uri) {
      const st = await fs.promises.stat(uri.fsPath);
      return { type: st.isDirectory() ? 2 : 1, size: st.size, mtime: st.mtimeMs };
    },
    async rename(src, dest) {
      await fs.promises.mkdir(path.dirname(dest.fsPath), { recursive: true });
      await fs.promises.rename(src.fsPath, dest.fsPath);
    },
    async delete(uri) {
      await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
    }
  };

  const discoveryAudit = await WorkspaceDiscoveryService.discover(auditRootUri, {
    maxEntries: 100,
    maxDepth: 3,
    numCtx: NUM_CTX
  });

  console.log(`Discovered Files: ${discoveryAudit.totalFilesDiscovered}`);
  console.log(`Detected Stacks: [${discoveryAudit.detectedStacks.join(', ')}]`);
  console.log(`Manifests Prioritized: [${discoveryAudit.manifestFiles.join(', ')}]`);
  console.log(`Key Entry Files Present: [${discoveryAudit.keyEntryFilesPresent.join(', ')}]`);
  console.log(`Pruned Directories Count: ${discoveryAudit.prunedDirectories?.length ?? 0}`);
  if (discoveryAudit.prunedDirectories) {
    console.log(`Pruned Directories Excerpt:`, discoveryAudit.prunedDirectories.slice(0, 3));
  }
  const manifestPrioritized = discoveryAudit.manifestFiles.some(m => m.includes('Backend.Api.csproj'));
  console.log(`Did caps truncate critical manifests? ${manifestPrioritized ? 'NO (Manifests correctly prioritized)' : 'YES (DEFECT)'}`);

  fs.rmSync(auditTempDir, { recursive: true, force: true });

  // 2. Evaluated Prompts & Models
  const benchmarkPrompts = [
    { id: 'prompt_a', name: 'angular is partially implemented', text: 'angular is partially implemented' },
    { id: 'prompt_b', name: 'Missing pieces (original)', text: 'Missing pieces to make this project actually usable: Clean up backend controller (stray ``` characters and Guid mismatch), align API contract and port configuration with launchSettings. fix it' },
    { id: 'prompt_c', name: 'fix the build errors', text: 'fix the build errors in Backend.Api' }
  ];

  const models = ['qwen2.5-coder:7b', 'qwen3.5:9b'];

  const conditions = [
    { name: 'Old Rules + OFF', useNewRule: false, discoveryAndGateOn: false },
    { name: 'Old Rules + ON', useNewRule: false, discoveryAndGateOn: true },
    { name: 'New Rules + OFF', useNewRule: true, discoveryAndGateOn: false },
    { name: 'New Rules + ON', useNewRule: true, discoveryAndGateOn: true }
  ];

  const rawRuns = [];
  const summaryRows = [];

  for (const model of models) {
    console.log(`\n======================================================`);
    console.log(`EVALUATING MODEL: ${model}`);
    const caps = await ollama.getModelCapabilities(model);
    console.log(`Capabilities from /api/show:`, JSON.stringify(caps.capabilities));

    for (const cond of conditions) {
      console.log(`\n--- Condition: ${cond.name} ---`);

      // Update Orchestrator prompt text (True Baseline test override)
      if (cond.useNewRule) {
        OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(OLD_RULE_8, NEW_RULE_8);
      } else {
        OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(NEW_RULE_8, OLD_RULE_8);
      }

      // Configure extension settings via mock configuration
      updateMockConfiguration('localCopilot.agent.enableWorkspaceDiscoveryPreStep', cond.discoveryAndGateOn);
      updateMockConfiguration('localCopilot.agent.minExplorationBeforeAsk', cond.discoveryAndGateOn ? 3 : 0);
      updateMockConfiguration('localCopilot.agent.maxClarificationQuestionsPerTask', 2);

      for (const p of benchmarkPrompts) {
        for (let seedIdx = 0; seedIdx < SEEDS.length; seedIdx++) {
          const seed = SEEDS[seedIdx];
          const runTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${model.replace(/[:.]/g, '_')}-${p.id}-s${seed}-`));
          createSyntheticProjectFixture(runTempDir);
          const runRootUri = vscodeMock.Uri.file(runTempDir);
          resetMockState(runTempDir);
          setMockWorkspaceFolders([{ uri: runRootUri, name: 'bench-app', index: 0 }]);

          let firstTurnAsk = false;
          let turnNumber = 0;
          let firstWriteTurn = null;
          let questionsAttempted = 0;
          let questionsAllowed = 0;
          let escapeHatchFired = false;
          let toolsCalled = [];
          let executionError = null;

          const orchestrator = new SwarmOrchestrator(ollama, {
            maxTurns: MAX_TURNS,
            numCtx: NUM_CTX,
            temperature: TEMPERATURE,
            autonomousMode: true,
            userModel: model,
            availableModels: [model],
            workspaceRootUri: runRootUri
          });

          const callbacks = {
            onProgress: (prog) => {
              if (prog.message?.includes('Escape hatch')) escapeHatchFired = true;
            },
            onToolStart: (call) => {
              const name = call.function.name;
              toolsCalled.push(name);
              if (['str_replace', 'create_file', 'apply_patch', 'applyStructuredEdits'].includes(name)) {
                if (firstWriteTurn === null) firstWriteTurn = turnNumber;
              }
              if (name === 'ask_user') {
                questionsAttempted++;
                if (turnNumber === 1) firstTurnAsk = true;
              }
            },
            onToolEnd: (toolRes) => {
              if (toolRes.name === 'ask_user' && toolRes.success) {
                questionsAllowed++;
              }
            },
            onAskUser: async (q) => {
              questionsAllowed++;
              return 'Please inspect existing files and proceed.';
            }
          };

          let agentOutput = '';
          try {
            turnNumber = 1;
            agentOutput = await orchestrator.runTask(p.text, callbacks, AbortSignal.timeout(45000));
          } catch (err) {
            executionError = err.message;
            agentOutput = `Execution error: ${err.message}`;
          }

          if (turnNumber === 1 && !firstTurnAsk && (agentOutput.includes('?') || /which framework|what backend/i.test(agentOutput))) {
            firstTurnAsk = true;
          }

          const outcome = evaluateDetailedOutcome(runTempDir);
          let whyNoWrite = 'N/A';
          if (firstWriteTurn === null) {
            if (executionError) whyNoWrite = `Execution error: ${executionError.slice(0, 40)}`;
            else if (toolsCalled.length === 0) whyNoWrite = 'Emitted conversational text with 0 tool calls';
            else whyNoWrite = `Executed read-only tools [${toolsCalled.join(', ')}] without write`;
          }

          const clarifRate = questionsAttempted > 0 ? Math.min(100, Math.round((questionsAllowed / questionsAttempted) * 100)) : null;

          const record = {
            model,
            condition: cond.name,
            promptId: p.id,
            seed,
            firstTurnAsk,
            questionsAttempted,
            questionsAllowed,
            clarifAllowedRate: clarifRate !== null ? `${clarifRate}%` : 'N/A',
            escapeHatchFired,
            firstWriteTurn: firstWriteTurn !== null ? firstWriteTurn : 'None',
            whyNoWrite,
            toolsCalled: toolsCalled.slice(0, 6),
            subChecks: {
              fencesRemoved: outcome.fencesRemoved,
              idTypesAligned: outcome.idTypesAligned,
              propertyNamesAligned: outcome.propertyNamesAligned,
              portsAligned: outcome.portsAligned,
              dotnetBuildExitZero: outcome.dotnetBuildExitZero
            },
            overallPass: outcome.overallPass
          };

          rawRuns.push(record);
          console.log(`  [${p.id}|seed ${seed}] firstTurnAsk=${firstTurnAsk} | writeTurn=${record.firstWriteTurn} (${whyNoWrite}) | subChecks: [fences:${outcome.fencesRemoved}, build:${outcome.dotnetBuildExitZero}] | overall=${outcome.overallPass ? 'PASS' : 'FAIL'}`);

          try { fs.rmSync(runTempDir, { recursive: true, force: true }); } catch {}
        }
      }
    }
  }

  // Restore prompt text to default
  OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(OLD_RULE_8, NEW_RULE_8);

  const outPath = path.join(__dirname, 'four_condition_ablation_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ metadata: { endpoint: OLLAMA_ENDPOINT, numCtx: NUM_CTX, temp: TEMPERATURE, seeds: SEEDS, smi: getHardwareFingerprint() }, rawRuns }, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

runBenchmark().catch(err => {
  console.error('Benchmark execution error:', err);
  process.exit(1);
});
