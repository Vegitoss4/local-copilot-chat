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

// Mount real fs onto vscodeMock.workspace.fs
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

const activeDocuments = new Map();
vscodeMock.workspace.openTextDocument = async (uri) => {
  const norm = path.normalize(uri.fsPath);
  let content = '';
  if (fs.existsSync(norm)) {
    content = fs.readFileSync(norm, 'utf8');
  } else {
    content = exports.mockFs ? (exports.mockFs.getFile(norm) || '') : '';
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
      let startOffset = 0;
      for (let i = 0; i < op.range.start.line; i++) {
        startOffset += lines[i].length + 1;
      }
      startOffset += op.range.start.character;

      let endOffset = 0;
      for (let i = 0; i < op.range.end.line; i++) {
        endOffset += lines[i].length + 1;
      }
      endOffset += op.range.end.character;

      text = text.slice(0, startOffset) + op.newText + text.slice(endOffset);
      if (doc) doc.currentContent = text;
      fs.writeFileSync(norm, text, 'utf8');
    }
  }
  return true;
};

const OLD_RULE_8 = "8. If the user's requirements are ambiguous or you need architectural direction, use 'ask_user' to pause and ask the developer.";
const NEW_RULE_8 = "8. Inspect the workspace first using read tools. Only use 'ask_user' for decisions the workspace cannot answer (e.g. business trade-offs, credentials). Never ask about facts discoverable in files.";

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
  let fencesRemoved = false;
  if (fs.existsSync(controllerPath)) {
    const content = fs.readFileSync(controllerPath, 'utf8');
    fencesRemoved = !content.includes('```');
  }

  let dotnetBuildExitZero = false;
  try {
    const buildRes = cp.spawnSync('dotnet', ['build', path.join(workspaceDir, 'Backend.Api', 'Backend.Api.csproj')], {
      encoding: 'utf8',
      timeout: 30000
    });
    dotnetBuildExitZero = buildRes.status === 0;
  } catch {}

  return { fencesRemoved, dotnetBuildExitZero, pass: fencesRemoved && dotnetBuildExitZero };
}

async function runQwen35Ablation() {
  const MODEL = 'qwen3.5:9b';
  const NUM_CTX = 8192;
  const TEMPERATURE = 0.2;
  const MAX_TURNS = 10;
  const WALL_CLOCK_TIMEOUT_MS = 600000; // 10 minutes per cell

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, 'qwen35_ablation_results.json');

  let storedData = {
    metadata: {
      title: 'qwen3.5:9b Ablation: Old Rules (Baseline) vs New Rules + Discovery + Gate (Hardened)',
      model: MODEL,
      timestamp: new Date().toISOString(),
      numCtx: NUM_CTX,
      temperature: TEMPERATURE,
      maxTurns: MAX_TURNS,
      wallClockLimitMs: WALL_CLOCK_TIMEOUT_MS
    },
    runs: []
  };

  if (fs.existsSync(outPath)) {
    try { storedData = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  }

  const prompts = [
    { id: 'prompt_a', name: 'angular is partially implemented', text: 'angular is partially implemented' },
    { id: 'prompt_b', name: 'Missing pieces (original)', text: 'Missing pieces to make this project actually usable: A proper Angular frontend scaffold under Frontend.Client (empty now), cleaned-up backend controller (stray ``` characters and Guid mismatch), align API contract and port configuration with launchSettings.' },
    { id: 'prompt_c', name: 'fix the build errors', text: 'fix the build errors in Backend.Api' }
  ];

  const seeds = [42, 101];

  const conditions = [
    { name: 'Old Rules (Baseline)', useNewRule: false, discoveryAndGateOn: false },
    { name: 'New Rules + Discovery + Gate (Hardened)', useNewRule: true, discoveryAndGateOn: true }
  ];

  const ollama = new OllamaService('http://127.0.0.1:11434');

  console.log(`=== Starting qwen3.5:9b Ablation (Total ${conditions.length * prompts.length * seeds.length} cells | 10 min wall-clock limit) ===\n`);

  for (const cond of conditions) {
    console.log(`\n======================================================`);
    console.log(`Condition: ${cond.name}`);

    if (cond.useNewRule) {
      OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(OLD_RULE_8, NEW_RULE_8);
    } else {
      OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(NEW_RULE_8, OLD_RULE_8);
    }

    for (const p of prompts) {
      for (const seed of seeds) {
        const existing = storedData.runs.find(
          r => r.condition === cond.name && r.promptId === p.id && r.seed === seed
        );
        if (existing) {
          console.log(`[SKIP] Already recorded: ${cond.name} | ${p.id} | seed ${seed} (${existing.status})`);
          continue;
        }

        console.log(`\nRunning: ${cond.name} | ${p.id} | Seed: ${seed}`);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `qwen35-abl-${p.id}-s${seed}-`));
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
        const toolsCalled = [];
        let runError = null;
        let status = 'COMPLETED';

        const orchestrator = new SwarmOrchestrator(ollama, {
          maxTurns: MAX_TURNS,
          numCtx: NUM_CTX,
          temperature: TEMPERATURE,
          autonomousMode: true,
          userModel: MODEL,
          availableModels: [MODEL],
          workspaceRootUri: rootUri
        });

        const originalChat = ollama.chatWithTools.bind(ollama);
        ollama.chatWithTools = async (...args) => {
          turnNumber++;
          const res = await originalChat(...args);
          if (turnNumber === 1) {
            const hasAskUser = res.tool_calls?.some(tc => tc.function?.name === 'ask_user');
            const hasOtherTools = res.tool_calls && res.tool_calls.length > 0;
            const content = (res.content || '').trim();
            // Metric definition: orchestrator's first turn calls ask_user or emits a clarification with no tool call
            const emitsClarificationNoTools = !hasOtherTools && content.length > 0 && (
              content.includes('?') ||
              /clarif|which|framework|should I|would you|do you want|please specify/i.test(content)
            );
            if (hasAskUser || emitsClarificationNoTools) {
              firstTurnAsk = true;
            }
          }
          return res;
        };

        const startTime = Date.now();
        try {
          await orchestrator.runTask(p.text, {
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
              return 'Please inspect existing files and proceed with the necessary fixes.';
            }
          }, AbortSignal.timeout(WALL_CLOCK_TIMEOUT_MS));
        } catch (err) {
          runError = err.message;
          if (err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('aborted')) {
            status = 'CENSORED';
          }
        }

        const durationMs = Date.now() - startTime;
        const outcome = evaluateOutcome(tempDir);

        const runRecord = {
          model: MODEL,
          condition: cond.name,
          promptId: p.id,
          promptName: p.name,
          seed,
          status,
          firstTurnAsk,
          turnsCount: turnNumber,
          firstWriteTurn,
          toolsCalled,
          questionsAttempted,
          questionsAllowed,
          outcome,
          durationMs,
          runError
        };

        storedData.runs.push(runRecord);
        fs.writeFileSync(outPath, JSON.stringify(storedData, null, 2), 'utf8');
        console.log(`  Finished: Status=${status} | FirstTurnAsk=${firstTurnAsk} | Turns=${turnNumber} | FirstWriteTurn=${firstWriteTurn} | OutcomePass=${outcome.pass} | Duration=${(durationMs / 1000).toFixed(1)}s`);

        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  console.log(`\n=== Ablation complete! Written to: ${outPath} ===`);
}

runQwen35Ablation().catch(console.error);
