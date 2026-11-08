const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');
global.fetch = nativeFetch;

const { OllamaService } = require('../../out/services/ollamaService');
const { SwarmOrchestrator } = require('../../out/services/swarmOrchestrator');
const { OrchestratorAgent } = require('../../out/services/agentRegistry');
const { resetMockState, setMockWorkspaceFolders, updateMockConfiguration } = require('../../out-test/test/mocks/vscodeMock.js');

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const NUM_CTX = 8192;
const TEMPERATURE = 0.2;
const SEEDS = [42, 101];
const MAX_TURNS = 10;

const OLD_RULE_8 = `8. If the user's requirements are ambiguous or you need architectural direction, use 'ask_user' to pause and ask the developer.`;
const NEW_RULE_8 = `8. NEVER call ask_user or ask the user for architectural or framework choices before thoroughly inspecting the workspace. Always inspect existing manifests, configuration, and code files first using read-only exploration tools. Only invoke ask_user when a decision cannot be deduced from existing workspace files (e.g. choosing between two mutually exclusive design options when no existing code indicates a preference). If the user asks a question or makes an architectural statement without an explicit edit instruction, investigate the workspace, report what you find, and propose concrete next steps.`;

// Bridge filesystem, openTextDocument, applyEdit, save
const activeDocuments = new Map();

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

vscodeMock.workspace.openTextDocument = async (uri) => {
  const norm = path.normalize(uri.fsPath);
  let content = '';
  if (fs.existsSync(norm)) {
    content = fs.readFileSync(norm, 'utf8');
  }

  const doc = {
    uri,
    fileName: norm,
    isDirty: false,
    currentContent: content,
    getText: () => doc.currentContent,
    positionAt: (offset) => {
      const prefix = doc.currentContent.slice(0, offset);
      const lines = prefix.split('\n');
      return new vscodeMock.Position(lines.length - 1, lines[lines.length - 1].length);
    },
    lineCount: content.split('\n').length,
    save: async () => {
      fs.writeFileSync(norm, doc.currentContent, 'utf8');
      doc.isDirty = false;
      return true;
    }
  };

  activeDocuments.set(norm, doc);
  return doc;
};

vscodeMock.workspace.applyEdit = async (edit) => {
  for (const op of edit.operations) {
    const norm = path.normalize(op.uri.fsPath);
    let doc = activeDocuments.get(norm);
    let text = doc ? doc.getText() : (fs.existsSync(norm) ? fs.readFileSync(norm, 'utf8') : '');

    if (op.type === 'replace' && op.range) {
      const lines = text.split('\n');
      const startLine = lines[op.range.start.line] || '';
      const endLine = lines[op.range.end.line] || '';
      const before = lines.slice(0, op.range.start.line).join('\n') +
        (op.range.start.line > 0 ? '\n' : '') +
        startLine.substring(0, op.range.start.character);
      const after = endLine.substring(op.range.end.character) +
        (op.range.end.line < lines.length - 1 ? '\n' : '') +
        lines.slice(op.range.end.line + 1).join('\n');
      text = before + op.newText + after;
    }

    if (doc) {
      doc.currentContent = text;
      doc.isDirty = true;
      fs.writeFileSync(norm, text, 'utf8');
    } else {
      fs.writeFileSync(norm, text, 'utf8');
    }
  }
  return true;
};

function createSyntheticProjectFixture(targetDir) {
  const backendDir = path.join(targetDir, 'Backend.Api');
  const controllerDir = path.join(backendDir, 'Controllers');
  const modelsDir = path.join(backendDir, 'Models');
  const propsDir = path.join(backendDir, 'Properties');

  const frontendDir = path.join(targetDir, 'Frontend.Client');
  const appDir = path.join(frontendDir, 'src', 'app');
  const servicesDir = path.join(appDir, 'services');

  fs.mkdirSync(controllerDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(propsDir, { recursive: true });
  fs.mkdirSync(servicesDir, { recursive: true });

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
    JSON.stringify({ profiles: { 'Backend.Api': { applicationUrl: 'https://localhost:7041;http://localhost:5041' } } }, null, 2)
  );

  fs.writeFileSync(
    path.join(servicesDir, 'taskitem.service.ts'),
    'export class TaskItemService { private apiUrl = "https://localhost:7001/api/taskitems"; }'
  );
}

function evaluateOutcome(workspaceDir) {
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

  const pass = fencesRemoved && idTypesAligned && propertyNamesAligned && portsAligned && dotnetBuildExitZero;
  return { fencesRemoved, idTypesAligned, propertyNamesAligned, portsAligned, dotnetBuildExitZero, pass };
}

async function runReducedAblation() {
  const ollama = new OllamaService(OLLAMA_ENDPOINT);
  const resultsDir = path.resolve(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const outPath = path.join(resultsDir, 'reduced_ablation_results.json');

  let storedData = {
    metadata: {
      title: 'Reduced 2-Condition Ablation Benchmark (Old Rules vs New Rules + Discovery + Gate)',
      timestamp: new Date().toISOString(),
      models: ['qwen2.5-coder:7b', 'qwen3.5:9b'],
      seeds: SEEDS,
      numCtx: NUM_CTX,
      temperature: TEMPERATURE,
      maxTurns: MAX_TURNS
    },
    runs: []
  };

  if (fs.existsSync(outPath)) {
    try {
      storedData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {}
  }

  const prompts = [
    { id: 'prompt_a', name: 'angular is partially implemented', text: 'angular is partially implemented' },
    { id: 'prompt_b', name: 'Missing pieces (original)', text: 'Missing pieces to make this project actually usable: Clean up backend controller (stray ``` characters and Guid mismatch), align API contract and port configuration with launchSettings. fix it' },
    { id: 'prompt_c', name: 'fix the build errors', text: 'fix the build errors in Backend.Api' }
  ];

  const models = ['qwen2.5-coder:7b', 'qwen3.5:9b'];

  const conditions = [
    { name: 'Old Rules (Baseline)', useNewRule: false, discoveryAndGateOn: false },
    { name: 'New Rules + Discovery + Gate (Hardened)', useNewRule: true, discoveryAndGateOn: true }
  ];

  console.log(`=== Starting Reduced Ablation Benchmark (Total ${conditions.length * models.length * prompts.length * SEEDS.length} cells) ===`);

  for (const model of models) {
    for (const cond of conditions) {
      console.log(`\n======================================================`);
      console.log(`Model: ${model} | Condition: ${cond.name}`);

      // Set prompt rule
      if (cond.useNewRule) {
        OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(OLD_RULE_8, NEW_RULE_8);
      } else {
        OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(NEW_RULE_8, OLD_RULE_8);
      }

      for (const p of prompts) {
        for (const seed of SEEDS) {
          // Check resumption
          const existing = storedData.runs.find(
            r => r.model === model && r.condition === cond.name && r.promptId === p.id && r.seed === seed
          );
          if (existing) {
            console.log(`[SKIP] Already completed: ${model} | ${cond.name} | ${p.id} | seed ${seed}`);
            continue;
          }

          console.log(`\nRunning: ${model} | ${cond.name} | ${p.id} | Seed: ${seed}`);
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `red-abl-${model.replace(/[:.]/g, '_')}-${p.id}-s${seed}-`));
          createSyntheticProjectFixture(tempDir);
          const rootUri = vscodeMock.Uri.file(tempDir);
          resetMockState(tempDir);
          setMockWorkspaceFolders([{ uri: rootUri, name: 'ablation-app', index: 0 }]);

          updateMockConfiguration('localCopilot.agent.enableWorkspaceDiscoveryPreStep', cond.discoveryAndGateOn);
          updateMockConfiguration('localCopilot.agent.minExplorationBeforeAsk', cond.discoveryAndGateOn ? 3 : 0);
          updateMockConfiguration('localCopilot.agent.maxClarificationQuestionsPerTask', 2);

          let firstTurnAsk = false;
          let turnNumber = 0;
          let firstWriteTurn = null;
          let questionsAttempted = 0;
          let questionsAllowed = 0;
          let escapeHatchFired = false;
          const toolsCalled = [];
          let runError = null;

          const orchestrator = new SwarmOrchestrator(ollama, {
            maxTurns: MAX_TURNS,
            numCtx: NUM_CTX,
            temperature: TEMPERATURE,
            autonomousMode: true,
            userModel: model,
            availableModels: [model],
            workspaceRootUri: rootUri
          });

          // Intercept turns to detect first-turn behavior
          const originalChat = ollama.chatWithTools.bind(ollama);
          ollama.chatWithTools = async (...args) => {
            turnNumber++;
            const res = await originalChat(...args);
            if (turnNumber === 1) {
              const hasAskUser = res.tool_calls?.some(tc => tc.function?.name === 'ask_user');
              const hasOtherTools = res.tool_calls && res.tool_calls.length > 0;
              const hasClarificationText = (res.content || '').toLowerCase().includes('which framework') ||
                (res.content || '').toLowerCase().includes('could you clarify') ||
                (res.content || '').toLowerCase().includes('please clarify');
              if (hasAskUser || (!hasOtherTools && hasClarificationText)) {
                firstTurnAsk = true;
              }
            }
            return res;
          };

          try {
            await orchestrator.runTask(p.text, {
              onProgress: (prog) => {
                if (prog.message?.includes('Escape hatch')) escapeHatchFired = true;
              },
              onToolStart: (call) => {
                const name = call.function.name;
                toolsCalled.push(name);
                if (['str_replace', 'create_file', 'apply_patch'].includes(name)) {
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
            }, AbortSignal.timeout(60000));
          } catch (err) {
            runError = err.message;
          }

          const outcome = evaluateOutcome(tempDir);
          const clarificationAllowedRate = questionsAttempted > 0 ? (questionsAllowed / questionsAttempted) : 1.0;

          const runRec = {
            model,
            condition: cond.name,
            promptId: p.id,
            promptName: p.name,
            seed,
            firstTurnAsk,
            questionsAttempted,
            questionsAllowed,
            clarificationAllowedRate,
            firstWriteTurn,
            escapeHatchFired,
            toolsCalled,
            outcome,
            runError
          };

          storedData.runs.push(runRec);
          fs.writeFileSync(outPath, JSON.stringify(storedData, null, 2), 'utf8');
          console.log(`  Finished: FirstTurnAsk=${firstTurnAsk}, TurnsToFirstWrite=${firstWriteTurn}, OutcomePass=${outcome.pass}, Error=${runError || 'none'}`);

          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
      }
    }
  }

  console.log(`\n=== Reduced Ablation Complete! Output: ${outPath} ===`);
}

runReducedAblation().catch(console.error);
