const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');
global.fetch = nativeFetch;

const { OllamaService } = require('../../out/services/ollamaService');
const { SwarmOrchestrator } = require('../../out/services/swarmOrchestrator');
const { resetMockState, setMockWorkspaceFolders } = require('../../out-test/test/mocks/vscodeMock.js');

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

// Bridge openTextDocument, applyEdit, and save to real filesystem
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

const cp = require('child_process');

function createFixture(targetDir) {
  const backendDir = path.join(targetDir, 'Backend.Api');
  const controllerDir = path.join(backendDir, 'Controllers');
  fs.mkdirSync(controllerDir, { recursive: true });
  fs.writeFileSync(
    path.join(backendDir, 'Backend.Api.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>`
  );
  fs.writeFileSync(
    path.join(backendDir, 'Program.cs'),
    `var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddControllers();\nvar app = builder.Build();\napp.MapControllers();\napp.Run();`
  );
  fs.writeFileSync(
    path.join(controllerDir, 'TaskItemsController.cs'),
    `using Microsoft.AspNetCore.Mvc;\n\n\`\`\`\n[ApiController]\npublic class TaskItemsController : ControllerBase {}\n\`\`\``
  );
}

const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir, { recursive: true });
}

async function runTracedSmoke(model, runIndex) {
  console.log(`\n=== RUNNING TRACED SMOKE RUN ${runIndex + 1} ON: ${model} ===`);
  console.log('CP1: creating fixture');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `trace-${model.replace(/[:.]/g, '_')}-r${runIndex}-`));
  createFixture(tempDir);
  console.log('CP2: resetting mock state');
  const rootUri = vscodeMock.Uri.file(tempDir);
  resetMockState(tempDir);
  setMockWorkspaceFolders([{ uri: rootUri, name: 'trace-app', index: 0 }]);
  console.log('CP3: setting up ollama');
  const ollama = new OllamaService('http://127.0.0.1:11434');

  const interceptedCalls = [];
  const originalChatWithTools = ollama.chatWithTools.bind(ollama);

  ollama.chatWithTools = async (m, msgs, tools, sig, opts, timeouts) => {
    console.log(`[Turn intercepted] Model: ${m}, tools: ${tools ? tools.length : 0}`);
    const offeredToolNames = tools ? tools.map(t => (t.function ? t.function.name : t.name)) : [];

    let parsedResult = null;
    let callError = null;
    try {
      parsedResult = await originalChatWithTools(m, msgs, tools, sig, opts, timeouts);
      console.log(`[Turn Result] Content: "${parsedResult?.content?.slice(0, 60)}", ToolCalls: ${parsedResult?.tool_calls ? JSON.stringify(parsedResult.tool_calls.map(tc => tc.function.name)) : 'none'}`);
    } catch (err) {
      callError = err.message;
      console.log(`[Turn Error]:`, err);
    }

    interceptedCalls.push({
      turn: interceptedCalls.length + 1,
      model: m,
      offeredToolNames,
      rawContent: parsedResult ? parsedResult.content : null,
      rawToolCalls: parsedResult ? parsedResult.tool_calls : null,
      callError
    });

    if (callError) throw new Error(callError);
    return parsedResult;
  };

  console.log('CP4: instantiating SwarmOrchestrator');
  const dispatchActions = [];
  const orchestrator = new SwarmOrchestrator(ollama, {
    maxTurns: 10,
    numCtx: 4096,
    temperature: 0.2,
    autonomousMode: true,
    userModel: model,
    availableModels: [model],
    workspaceRootUri: rootUri
  });

  const prompt = 'remove the stray ``` lines from Backend.Api/Controllers/TaskItemsController.cs';
  let orchestratorOutput = '';
  let runError = null;

  console.log('CP5: calling orchestrator.runTask');
  try {
    orchestratorOutput = await orchestrator.runTask(prompt, {
      onToolStart: (c) => {
        dispatchActions.push({
          phase: 'start',
          name: c.function.name,
          arguments: c.function.arguments
        });
      },
      onToolEnd: (r) => {
        dispatchActions.push({
          phase: 'end',
          name: r.name,
          success: r.success,
          outputExcerpt: (r.output || '').slice(0, 200)
        });
      },
      onAskUser: async (q) => {
        dispatchActions.push({
          phase: 'ask_user',
          question: q
        });
        return 'Yes, please remove the stray markdown fences from the file and verify the build.';
      }
    }, AbortSignal.timeout(90000));
  } catch (err) {
    runError = err.message;
  }

  const filePath = path.join(tempDir, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
  const finalFileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const fencesRemoved = !finalFileContent.includes('```');

  let dotnetBuildExitZero = false;
  try {
    const buildRes = cp.spawnSync('dotnet', ['build', path.join(tempDir, 'Backend.Api', 'Backend.Api.csproj')], {
      encoding: 'utf-8',
      timeout: 30000
    });
    dotnetBuildExitZero = buildRes.status === 0;
  } catch {}

  const traceRecord = {
    model,
    runIndex: runIndex + 1,
    prompt,
    runError,
    orchestratorOutput: (orchestratorOutput || '').slice(0, 500),
    turnsIntercepted: interceptedCalls,
    dispatchActions,
    finalFileContent,
    fencesRemoved,
    dotnetBuildExitZero,
    pass: fencesRemoved && dotnetBuildExitZero
  };

  const outPath = path.join(
    resultsDir,
    `smoke_trace_${model.replace(/[:.]/g, '_')}_run${runIndex + 1}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(traceRecord, null, 2));
  console.log(`Saved trace to: ${outPath}`);
  console.log(`  Turns: ${interceptedCalls.length}, Dispatched: [${dispatchActions.filter(d => d.phase === 'start').map(d => d.name).join(', ')}], Fences Removed: ${fencesRemoved}`);

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  return traceRecord;
}

async function main() {
  const models = ['qwen2.5-coder:7b', 'qwen3.5:9b'];
  for (const m of models) {
    for (let i = 0; i < 3; i++) {
      await runTracedSmoke(m, i);
    }
  }
  console.log('\n=== ALL SMOKE TRACES COMPLETED ===');
}

module.exports = { runTracedSmoke, main };

if (require.main === module) {
  main().catch(err => {
    console.error('Smoke trace failed:', err);
    process.exit(1);
  });
}
