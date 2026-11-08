const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
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

function createFixture(targetDir) {
  const backendDir = path.join(targetDir, 'Backend.Api');
  const controllerDir = path.join(backendDir, 'Controllers');
  const modelsDir = path.join(backendDir, 'Models');
  fs.mkdirSync(controllerDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });

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
    `namespace Backend.Api.Models;\npublic class TaskItem { public int Id { get; set; } }`
  );

  fs.writeFileSync(
    path.join(controllerDir, 'TaskItemsController.cs'),
    `using Microsoft.AspNetCore.Mvc;\nusing Backend.Api.Models;\n\nnamespace Backend.Api.Controllers;\n\n\`\`\`\n[ApiController]\n[Route("api/[controller]")]\npublic class TaskItemsController : ControllerBase {\n    [HttpGet]\n    public IActionResult Get() => Ok();\n}\n\`\`\``
  );
}

async function runCoderSmoke(streamMode, runIndex) {
  console.log(`\n======================================================`);
  console.log(`Running qwen2.5-coder:7b | stream=${streamMode} | Run ${runIndex + 1}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `coder-smoke-s${streamMode}-r${runIndex + 1}-`));
  createFixture(tempDir);
  const rootUri = vscodeMock.Uri.file(tempDir);
  resetMockState(tempDir);
  setMockWorkspaceFolders([{ uri: rootUri, name: 'smoke-app', index: 0 }]);

  const ollama = new OllamaService('http://127.0.0.1:11434');
  const prompt = 'remove the stray ``` lines from Backend.Api/Controllers/TaskItemsController.cs';

  const turns = [];
  const dispatchActions = [];
  let questionsAskedAsTool = 0;
  let questionsAskedAsPlainText = 0;

  // Intercept chatWithTools
  const origChatWithTools = ollama.chatWithTools.bind(ollama);
  ollama.chatWithTools = async (model, msgs, tools, sig, opts, timeouts, toolOpts) => {
    const turnIndex = turns.length + 1;
    const offeredTools = (tools || []).map(t => t.function?.name || t.name);

    // Force the stream option under test
    const effectiveToolOpts = { ...(toolOpts || {}), stream: streamMode };

    let rawOllamaResponse = null;
    let accumulatedChunks = [];
    let callError = null;

    // Spy on actual HTTP request/response directly to capture verbatim server output
    try {
      const endpoint = ollama.endpoint;
      const payload = {
        model,
        messages: ollama.cleanMessagesForOllama(msgs),
        tools: tools && tools.length > 0 ? tools : undefined,
        stream: streamMode,
        options: opts
      };

      const rawFetchRes = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!streamMode) {
        rawOllamaResponse = await rawFetchRes.json();
      } else {
        const reader = rawFetchRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) {
            if (l.trim()) {
              try {
                const c = JSON.parse(l.trim());
                accumulatedChunks.push(c);
              } catch {}
            }
          }
        }
      }
    } catch (e) {
      console.warn('Direct spy fetch error:', e.message);
    }

    // Now call the actual service method under test
    let res;
    try {
      res = await origChatWithTools(model, msgs, tools, sig, opts, timeouts, effectiveToolOpts);
    } catch (err) {
      callError = err.message;
      throw err;
    }

    const hasAskUserTool = res.tool_calls?.some(tc => tc.function?.name === 'ask_user');
    const content = res.content || '';
    const hasPlainQuestion = !hasAskUserTool && (
      content.includes('?') ||
      content.toLowerCase().includes('do you want') ||
      content.toLowerCase().includes('would you like') ||
      content.toLowerCase().includes('please clarify')
    );

    if (hasAskUserTool) questionsAskedAsTool++;
    if (hasPlainQuestion) questionsAskedAsPlainText++;

    turns.push({
      turn: turnIndex,
      offeredTools,
      streamMode,
      rawOllamaResponse,
      accumulatedChunksCount: accumulatedChunks.length,
      sampleChunks: accumulatedChunks.slice(0, 10),
      rawServerMessage: streamMode ? {
        content: accumulatedChunks.map(c => c.message?.content || '').join(''),
        tool_calls: accumulatedChunks.filter(c => c.message?.tool_calls).flatMap(c => c.message.tool_calls)
      } : rawOllamaResponse?.message,
      parsedToolCallsByAccumulator: res.tool_calls || null,
      accumulatorContent: res.content || '',
      hasAskUserTool,
      hasPlainQuestion
    });

    return res;
  };

  const orchestrator = new SwarmOrchestrator(ollama, {
    maxTurns: 10,
    numCtx: 4096,
    temperature: 0.2,
    autonomousMode: true,
    userModel: 'qwen2.5-coder:7b',
    availableModels: ['qwen2.5-coder:7b'],
    workspaceRootUri: rootUri
  });

  let runError = null;
  try {
    await orchestrator.runTask(prompt, {
      onToolStart: (c) => dispatchActions.push({ phase: 'start', name: c.function.name, args: c.function.arguments }),
      onToolEnd: (r) => dispatchActions.push({ phase: 'end', name: r.name, success: r.success }),
      onAskUser: async (q) => {
        dispatchActions.push({ phase: 'ask_user', question: q });
        return 'Please proceed and remove the stray markdown fences from the file.';
      }
    }, AbortSignal.timeout(90000));
  } catch (e) {
    runError = e.message;
  }

  const targetFile = path.join(tempDir, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
  const finalFileContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
  const fencesRemoved = !finalFileContent.includes('```');

  let dotnetBuildExitZero = false;
  try {
    const buildRes = cp.spawnSync('dotnet', ['build', path.join(tempDir, 'Backend.Api', 'Backend.Api.csproj')], {
      encoding: 'utf8',
      timeout: 30000
    });
    dotnetBuildExitZero = buildRes.status === 0;
  } catch {}

  const result = {
    model: 'qwen2.5-coder:7b',
    streamMode,
    runIndex: runIndex + 1,
    prompt,
    runError,
    turnsCount: turns.length,
    questionsAskedAsTool,
    questionsAskedAsPlainText,
    turns,
    dispatchActions,
    finalFileContent,
    fencesRemoved,
    dotnetBuildExitZero,
    pass: fencesRemoved && dotnetBuildExitZero
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `coder_smoke_stream_${streamMode}_run${runIndex + 1}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Saved: ${outPath} | FencesRemoved=${fencesRemoved} | BuildZero=${dotnetBuildExitZero} | Turns=${turns.length} | Questions(Tool=${questionsAskedAsTool}, Plain=${questionsAskedAsPlainText})`);

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  return result;
}

async function main() {
  const modes = [false, true];
  for (const m of modes) {
    for (let i = 0; i < 3; i++) {
      await runCoderSmoke(m, i);
    }
  }
}

main().catch(console.error);
