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

function isFirstTurnAsk(res) {
  if (res.tool_calls && res.tool_calls.some(tc => tc.function?.name === 'ask_user')) {
    return true;
  }
  const hasNoTools = !res.tool_calls || res.tool_calls.length === 0;
  if (hasNoTools) {
    const text = (res.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (text.length > 0) {
      if (text.includes('?')) return true;
      if (/(?:clarif|which\s+(?:framework|backend|frontend)|what\s+(?:framework|backend|frontend)|please\s+(?:specify|clarify|provide)|more\s+details|do\s+you\s+want|should\s+i)/i.test(text)) {
        return true;
      }
    }
  }
  return false;
}

// Verification of detector rule against key historical traces
console.log('Testing detector rule:');
console.log('  "I need clarification" ->', isFirstTurnAsk({ content: 'I need clarification before proceeding.' }));
console.log('  "Please provide more details" ->', isFirstTurnAsk({ content: 'Please provide more details on the architecture.' }));
console.log('  "Which backend framework is used?" ->', isFirstTurnAsk({ content: 'Which backend framework is used?' }));
console.log('  "Let me inspect the workspace." ->', isFirstTurnAsk({ content: 'Let me inspect the workspace files.' }));

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

function evaluateSubchecks(workspaceDir) {
  const controllerPath = path.join(workspaceDir, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
  let fencesRemoved = false;
  let idTypesAligned = false;
  let propertyNamesAligned = false;

  if (fs.existsSync(controllerPath)) {
    const content = fs.readFileSync(controllerPath, 'utf8');
    fencesRemoved = !content.includes('```');
    idTypesAligned = !content.includes('Guid id') && (content.includes('int id') || content.includes('int Id'));
    propertyNamesAligned = content.includes('IsCompleted') && !content.includes('existing.Completed');
  }

  const servicePath = path.join(workspaceDir, 'Frontend.Client', 'src', 'app', 'services', 'taskitem.service.ts');
  let portsAligned = false;
  if (fs.existsSync(servicePath)) {
    const content = fs.readFileSync(servicePath, 'utf8');
    portsAligned = content.includes('7041') || content.includes('5041');
  }

  let buildExitCode = null;
  try {
    const buildRes = cp.spawnSync('dotnet', ['build', path.join(workspaceDir, 'Backend.Api', 'Backend.Api.csproj')], {
      encoding: 'utf8',
      timeout: 30000
    });
    buildExitCode = buildRes.status;
  } catch {
    buildExitCode = -1;
  }

  const pass = fencesRemoved && idTypesAligned && propertyNamesAligned && portsAligned && buildExitCode === 0;
  return { fencesRemoved, idTypesAligned, propertyNamesAligned, portsAligned, buildExitCode, pass };
}

async function runPromptReplay() {
  const MODEL = 'qwen3.5:9b';
  const NUM_CTX = 8192;
  const TEMPERATURE = 0.2;
  const MAX_TURNS = 10;
  const WALL_CLOCK_TIMEOUT_MS = 300000; // 5 min per cell

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, 'user_prompt_replay_results.json');

  let storedData = {
    metadata: {
      title: 'User Prompt Replay: Old Rules vs New Code (N=5 each on qwen3.5:9b)',
      model: MODEL,
      timestamp: new Date().toISOString()
    },
    runs: []
  };

  const prompts = [
    {
      id: 'prompt_1_status',
      name: 'angular is partially implemented',
      text: 'angular is partially implemented'
    },
    {
      id: 'prompt_2_missing_pieces',
      name: 'Missing pieces (verbatim)',
      text: `Missing pieces to make this project actually usable:\n\nA proper Angular frontend scaffold under Frontend.Client\nA root solution/project file to run both backend and frontend together\nCleaned-up backend controller and aligned domain model\nMatching API contract and port configuration\nA README / startup instructions for running the app locally\nOptional seed data or database setup if you want demo content on first run\nIn short: the project is missing the real app wiring and a working build, not just minor polish.`
    }
  ];

  const seeds = [42, 101, 202, 303, 404];
  const conditions = [
    { name: 'Old Rules (Baseline)', useNewRule: false, discoveryAndGateOn: false },
    { name: 'New Code (Hardened)', useNewRule: true, discoveryAndGateOn: true }
  ];

  const ollama = new OllamaService('http://127.0.0.1:11434');

  console.log(`\n=== Starting User Prompt Replay (N=5 per condition, total ${conditions.length * prompts.length * seeds.length} cells) ===\n`);

  for (const cond of conditions) {
    console.log(`======================================================`);
    console.log(`Condition: ${cond.name}`);

    if (cond.useNewRule) {
      OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(OLD_RULE_8, NEW_RULE_8);
    } else {
      OrchestratorAgent.systemPrompt = OrchestratorAgent.systemPrompt.replace(NEW_RULE_8, OLD_RULE_8);
    }

    for (const p of prompts) {
      for (const seed of seeds) {
        console.log(`\nRunning: ${cond.name} | ${p.id} | Seed: ${seed}`);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `replay-${p.id}-s${seed}-`));
        createSyntheticProjectFixture(tempDir);
        const rootUri = vscodeMock.Uri.file(tempDir);
        resetMockState(tempDir);
        setMockWorkspaceFolders([{ uri: rootUri, name: 'replay-app', index: 0 }]);

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
            firstTurnAsk = isFirstTurnAsk(res);
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
              }
            },
            onToolEnd: (toolRes) => {
              if (toolRes.name === 'ask_user' && toolRes.success) {
                questionsAllowed++;
              }
            },
            onAskUser: async (q) => {
              return 'Please inspect the repository and proceed with the necessary implementations.';
            }
          }, AbortSignal.timeout(WALL_CLOCK_TIMEOUT_MS));
        } catch (err) {
          runError = err.message;
          if (err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('aborted')) {
            status = 'CENSORED';
          }
        }

        const durationMs = Date.now() - startTime;
        const subchecks = evaluateSubchecks(tempDir);

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
          subchecks,
          durationMs,
          runError
        };

        storedData.runs.push(runRecord);
        fs.writeFileSync(outPath, JSON.stringify(storedData, null, 2), 'utf8');
        console.log(`  Finished: Status=${status} | FirstTurnAsk=${firstTurnAsk} | Turns=${turnNumber} | FencesRemoved=${subchecks.fencesRemoved} | BuildExit=${subchecks.buildExitCode} | Duration=${(durationMs / 1000).toFixed(1)}s`);

        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  console.log(`\n=== Replay complete! Output written to: ${outPath} ===`);
}

runPromptReplay().catch(console.error);
