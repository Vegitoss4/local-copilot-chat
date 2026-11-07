import * as assert from 'assert';
import { MemoryService } from '../../src/services/memoryService';
import { OllamaService } from '../../src/services/ollamaService';
import { SwarmOrchestrator } from '../../src/services/swarmOrchestrator';
import { resetMockState, mockFs, MockUri } from '../mocks/vscodeMock';

describe('Phase 3 & 4: Agent Quality, Evidence Verification & Memory Hardening Suite', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(async () => {
    resetMockState(testRoot);
  });

  describe('1. MemoryService Secret Exclusion & Indexing Safety', () => {
    it('should exclude secret, credential, and certificate files from indexing', () => {
      const secretFiles = [
        '.env',
        '.env.local',
        '.env.production',
        'certs/server.pem',
        'keys/private.key',
        'auth/id_rsa',
        'auth/id_ed25519',
        'config/credentials.json',
        'secrets.json',
      ];

      for (const file of secretFiles) {
        assert.strictEqual(
          MemoryService.isIndexableFile(file),
          false,
          `Expected secret file '${file}' to be excluded from indexing`
        );
      }
    });

    it('should exclude build artifacts, dependencies, and binary assets from indexing', () => {
      const buildAndBinaryFiles = [
        'node_modules/lodash/index.js',
        '.git/config',
        'dist/bundle.js',
        'out/extension.js',
        'out-test/test.js',
        'bin/Debug/net8.0/app.dll',
        'obj/Debug/net8.0/app.pdb',
        'assets/logo.png',
        'downloads/archive.zip',
        'native/lib.so',
      ];

      for (const file of buildAndBinaryFiles) {
        assert.strictEqual(
          MemoryService.isIndexableFile(file),
          false,
          `Expected build/binary file '${file}' to be excluded from indexing`
        );
      }
    });

    it('should allow indexable source code files', () => {
      const validFiles = [
        'src/services/authService.ts',
        'src/components/button.tsx',
        'src/main.py',
        'Controllers/AccountController.cs',
        'internal/server/handler.go',
      ];

      for (const file of validFiles) {
        assert.strictEqual(
          MemoryService.isIndexableFile(file),
          true,
          `Expected source file '${file}' to be indexable`
        );
      }
    });

    it('should remove stale chunks when removeFileChunks is called', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const memory = new MemoryService(ollama);
      await memory.init();
      await memory.clear();

      await memory.indexFile('src/file1.ts', 'export const x = 1;', 'coder');
      await memory.indexFile('src/file2.ts', 'export const y = 2;', 'coder');

      assert.strictEqual(memory.getMemoryCount(), 2);

      const removed = await memory.removeFileChunks('src/file1.ts');
      assert.strictEqual(removed, 1);
      assert.strictEqual(memory.getMemoryCount(), 1);

      const searchRes = await memory.semanticSearch('export const x', 3);
      const foundFile1 = searchRes.some((r) => r.chunk.metadata.filePath === 'src/file1.ts');
      assert.strictEqual(foundFile1, false, 'Stale chunk should not be returned');
    });

    it('should recover gracefully when memory.json is corrupted on disk', async () => {
      const corruptJson = '{{{ invalid json text ...';
      mockFs.setFile('C:/Projects/test-workspace/.vscode/local-copilot/memory.json', corruptJson);

      const ollama = new OllamaService('http://127.0.0.1:11434');
      const memory = new MemoryService(ollama);
      await memory.init();

      // Should not throw, should initialize with 0 chunks and create backup
      assert.strictEqual(memory.getMemoryCount(), 0);
      const backup = mockFs.getFile('C:/Projects/test-workspace/.vscode/local-copilot/memory.json.corrupt');
      assert.strictEqual(backup, corruptJson, 'Corrupted data must be backed up for recovery');
    });
  });

  describe('2. Agent Evidence Verification (Phase 3.5)', () => {
    it('should challenge premature finish_task when files were modified without tester verification', async () => {
      const ollamaMock = new OllamaService('http://127.0.0.1:11434');
      (ollamaMock as any).resolveModelForRole = (_r: any, fallback: string) => fallback;

      let callCount = 0;
      let requestedDelegationToTester = false;

      ollamaMock.chatWithTools = async (_model, messages) => {
        callCount++;

        // Turn 1: Orchestrator delegates to coder
        if (callCount === 1) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_del_coder',
                function: {
                  name: 'delegate_task',
                  arguments: {
                    target_agent: 'coder',
                    task_description: 'Modify auth.ts',
                  },
                },
              },
            ],
          };
        }

        // Subagent coder execution
        if (callCount === 2) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_create_file',
                function: {
                  name: 'create_file',
                  arguments: { filePath: 'auth.ts', content: 'export const token = "abc";' },
                },
              },
            ],
          };
        }

        // Subagent coder hands back
        if (callCount === 3) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_coder_handback',
                function: {
                  name: 'hand_back',
                  arguments: { result_summary: 'auth.ts created', status: 'success' },
                },
              },
            ],
          };
        }

        // Turn 2 for orchestrator: orchestrator tries to call finish_task prematurely without tester verification
        if (callCount === 4) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_premature_finish',
                function: {
                  name: 'finish_task',
                  arguments: { final_summary: 'I am all done!' },
                },
              },
            ],
          };
        }

        // Turn 3: Check if orchestrator history contains the verification challenge
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'tool' && lastMsg.content.includes('Verification Required')) {
          requestedDelegationToTester = true;
        }

        // Now orchestrator properly delegates to tester
        if (callCount === 5) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_del_tester',
                function: {
                  name: 'delegate_task',
                  arguments: { target_agent: 'tester', task_description: 'Verify auth.ts' },
                },
              },
            ],
          };
        }

        // Subagent tester hands back success
        if (callCount === 6) {
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_tester_handback',
                function: {
                  name: 'hand_back',
                  arguments: { result_summary: 'No errors in auth.ts', status: 'success' },
                },
              },
            ],
          };
        }

        // Finally finish_task succeeds
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_final_finish',
              function: {
                name: 'finish_task',
                arguments: { final_summary: 'Verified and completed!' },
              },
            },
          ],
        };
      };

      const orchestrator = new SwarmOrchestrator(ollamaMock, {
        maxTurns: 10,
        autonomousMode: true,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      const finalAnswer = await orchestrator.runTask('Modify auth code', {});
      assert.strictEqual(requestedDelegationToTester, true, 'Orchestrator should have been challenged to verify with tester');
      assert.ok(finalAnswer.includes('Verified and completed!'));
    });
  });

  describe('3. Sub-Agent Repetition Loop Defense (Phase 3.1 & 3.3)', () => {
    it('should terminate sub-agent when repetitive tool calls are detected', async () => {
      const ollamaMock = new OllamaService('http://127.0.0.1:11434');
      (ollamaMock as any).resolveModelForRole = (_r: any, fallback: string) => fallback;

      let subIter = 0;
      ollamaMock.chatWithTools = async (_model, _msgs, tools) => {
        const isSubAgent = tools.some((t: any) => t.function.name === 'hand_back');

        if (!isSubAgent) {
          // Orchestrator delegates to coder
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_del',
                function: {
                  name: 'delegate_task',
                  arguments: { target_agent: 'coder', task_description: 'Write code' },
                },
              },
            ],
          };
        }

        subIter++;
        // Sub-agent repeatedly calls the exact same tool with identical arguments
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call_repeat_${subIter}`,
              function: {
                name: 'create_file',
                arguments: { filePath: 'loop.txt', content: 'infinite' },
              },
            },
          ],
        };
      };

      const orchestrator = new SwarmOrchestrator(ollamaMock, {
        maxTurns: 5,
        autonomousMode: true,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      // Swarm should terminate the sub-agent and record failure status
      await orchestrator.runTask('Do loop', {});
      const whiteboard = (orchestrator as any).whiteboard;
      const delegation = whiteboard.delegationHistory.find((d: any) => d.to === 'coder');

      assert.ok(delegation);
      assert.strictEqual(delegation.status, 'failure');
      assert.ok(delegation.result?.includes('repetitive loop'));
    });
  });

  describe('4. Ollama Tool Argument Resilience & Fallback Extraction', () => {
    it('should automatically parse stringified tool call arguments from native Ollama responses', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const originalFetch = global.fetch;

      try {
        global.fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_native_str',
                  function: {
                    name: 'create_file',
                    arguments: '{"filePath": "app.ts", "content": "console.log(1);"}' as any,
                  },
                },
              ],
            },
          }),
        } as any);

        const res = await ollama.chatWithTools('qwen2.5-coder:7b', [], []);
        assert.ok(res.tool_calls);
        assert.strictEqual(res.tool_calls.length, 1);
        assert.strictEqual(typeof res.tool_calls[0].function.arguments, 'object');
        assert.strictEqual(res.tool_calls[0].function.arguments.filePath, 'app.ts');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should extract raw JSON tool calls when model outputs JSON without markdown fences', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const originalFetch = global.fetch;

      try {
        global.fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              role: 'assistant',
              content: 'I will create the file now:\n{"name": "create_file", "arguments": {"filePath": "test.txt", "content": "hello"}}\nPlease review.',
            },
          }),
        } as any);

        const res = await ollama.chatWithTools('qwen2.5-coder:7b', [], []);
        assert.ok(res.tool_calls);
        assert.strictEqual(res.tool_calls.length, 1);
        assert.strictEqual(res.tool_calls[0].function.name, 'create_file');
        assert.strictEqual(res.tool_calls[0].function.arguments.filePath, 'test.txt');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('5. Swarm Task Isolation & Continuation (Fix 3.2)', () => {
    it('should isolate task-local state (modifiedFiles) on subsequent independent tasks', async () => {
      const ollamaMock = new OllamaService('http://127.0.0.1:11434');
      const orchestrator = new SwarmOrchestrator(ollamaMock, {
        maxTurns: 3,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
        isContinuation: false,
      });

      // Populate persisted whiteboard with previous task modifications
      const fileUri = (orchestrator as any).getWhiteboardFileUri();
      assert.ok(fileUri);
      await mockFs.createDirectory(MockUri.joinPath(fileUri, '..'));
      const previousState = {
        executionPlan: 'Step 1: Inspect\nStep 2: Fix',
        scratchpad: 'Project uses JWT',
        activeAgent: 'orchestrator',
        modifiedFiles: ['src/auth.ts', 'src/user.ts'],
        diagnostics: ['Error in auth.ts'],
        delegationHistory: [{ from: 'lead', to: 'coder', task: 'Fix auth', status: 'success' }],
      };
      await mockFs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(previousState)));

      // Mock chatWithTools to return immediate response without tool calls
      (ollamaMock as any).chatWithTools = async () => ({
        message: { role: 'assistant', content: 'What is this codebase about?' },
      });

      // Run new independent task (isContinuation = false)
      await orchestrator.runTask('What does the codebase do?', {});

      const whiteboard = (orchestrator as any).whiteboard;
      assert.strictEqual(whiteboard.modifiedFiles.length, 0, 'modifiedFiles must be cleared on new independent task');
      assert.strictEqual(whiteboard.diagnostics.length, 0, 'diagnostics must be cleared on new independent task');
      assert.strictEqual(whiteboard.delegationHistory.length, 0, 'delegationHistory must be cleared on new independent task');
      assert.strictEqual(whiteboard.scratchpad, 'Project uses JWT', 'Persistent scratchpad must be preserved');
      assert.strictEqual(whiteboard.executionPlan, '', 'Execution plan must be cleared on new independent task');
    });

    it('should retain modifiedFiles and executionPlan when isContinuation is true', async () => {
      const ollamaMock = new OllamaService('http://127.0.0.1:11434');
      const orchestrator = new SwarmOrchestrator(ollamaMock, {
        maxTurns: 3,
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
        isContinuation: true,
      });

      const fileUri = (orchestrator as any).getWhiteboardFileUri();
      assert.ok(fileUri);
      await mockFs.createDirectory(MockUri.joinPath(fileUri, '..'));
      const previousState = {
        executionPlan: 'Step 1: Inspect',
        scratchpad: 'Project uses JWT',
        activeAgent: 'orchestrator',
        modifiedFiles: ['src/auth.ts'],
        diagnostics: [],
        delegationHistory: [],
      };
      await mockFs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(previousState)));

      (ollamaMock as any).chatWithTools = async () => ({
        message: { role: 'assistant', content: 'Continuing fix.' },
      });

      // Run task with continuation = true
      await orchestrator.runTask('Continue fixing edge cases', {});

      const whiteboard = (orchestrator as any).whiteboard;
      assert.deepStrictEqual(whiteboard.modifiedFiles, ['src/auth.ts'], 'modifiedFiles must be retained on continuation');
      assert.strictEqual(whiteboard.executionPlan, 'Step 1: Inspect', 'executionPlan must be retained on continuation');
    });
  });

  describe('6. Genuine Atomic Persistence via fs.rename (Fix 4.1)', () => {
    it('should write to temporary file and atomically rename in MemoryService.saveToDisk', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const memory = new MemoryService(ollama);
      await memory.init();

      await memory.storeMemoryItem('Atomic test fact', { category: 'architecture', filePath: 'test.ts' });
      await memory.saveToDisk();

      // Check that destination file exists in mockFs
      const destUri = (memory as any).memoryFileUri;
      assert.ok(destUri, 'Destination URI must be defined');
      const data = await mockFs.readFile(destUri);
      assert.ok(data.length > 0, 'Saved memory file must not be empty');

      const parsed = JSON.parse(new TextDecoder('utf-8').decode(data));
      assert.ok(Array.isArray(parsed));
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].text, 'Atomic test fact');

      // Check that no temporary files are left behind
      const dirUri = MockUri.joinPath(destUri, '..');
      const dirEntries = await mockFs.readDirectory(dirUri);
      const tmpFiles = dirEntries.filter(([name]) => name.includes('.tmp.'));
      assert.strictEqual(tmpFiles.length, 0, 'No temporary files should linger after atomic rename');
    });

    it('should write to temporary file and atomically rename in SwarmOrchestrator.saveWhiteboardToDisk', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const orchestrator = new SwarmOrchestrator(ollama, {
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
      });

      (orchestrator as any).whiteboard = {
        executionPlan: '',
        scratchpad: 'Atomic whiteboard test',
        activeAgent: 'orchestrator',
        delegationHistory: [],
        modifiedFiles: [],
        diagnostics: [],
      };
      await orchestrator.saveWhiteboardToDisk();

      const fileUri = (orchestrator as any).getWhiteboardFileUri();
      assert.ok(fileUri, 'Whiteboard URI must be defined');
      const data = await mockFs.readFile(fileUri);
      assert.ok(data.length > 0, 'Saved whiteboard file must not be empty');

      const parsed = JSON.parse(new TextDecoder('utf-8').decode(data));
      assert.strictEqual(parsed.scratchpad, 'Atomic whiteboard test');

      const dirUri = MockUri.joinPath(fileUri, '..');
      const dirEntries = await mockFs.readDirectory(dirUri);
      const tmpFiles = dirEntries.filter(([name]) => name.includes('.tmp.'));
      assert.strictEqual(tmpFiles.length, 0, 'No temporary files should linger after whiteboard save');
    });
  });

  describe('7. ChatViewProvider Thought Token Sanitization (Fix 4.2)', () => {
    it('should strip <think>...</think> blocks from loaded chat history', async () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const { ChatViewProvider } = await import('../../src/providers/chatViewProvider');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);

      const historyUri = (provider as any)._getHistoryFileUri();
      assert.ok(historyUri);

      // Write mock history with raw thought blocks
      const rawHistory = [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: '<think>\nEvaluating 2+2 in arithmetic\nResult is 4\n</think>\nThe answer is 4.',
        },
      ];
      await mockFs.createDirectory(MockUri.joinPath(historyUri, '..'));
      await mockFs.writeFile(historyUri, new TextEncoder().encode(JSON.stringify(rawHistory)));

      const loaded = await (provider as any)._loadChatHistoryFromDisk();
      assert.strictEqual(loaded.length, 2);
      assert.strictEqual(loaded[0].content, 'What is 2+2?');
      assert.strictEqual(loaded[1].content, 'The answer is 4.', 'Thought tags must be stripped');
    });

    it('should strip unclosed trailing <think> blocks and case-insensitive tags', async () => {
      const { ChatViewProvider } = await import('../../src/providers/chatViewProvider');
      const unclosed = '<think>\nInternal reasoning still streaming...';
      const clean1 = ChatViewProvider.stripThoughtTokens(unclosed);
      assert.strictEqual(clean1, '', 'Unclosed trailing think block must be completely stripped');

      const upperCase = '<THINK>Internal secret reasoning</THINK>Here is the clean answer.';
      const clean2 = ChatViewProvider.stripThoughtTokens(upperCase);
      assert.strictEqual(clean2, 'Here is the clean answer.', 'Case-insensitive think tags must be stripped');

      const middleUnclosed = 'Prefix text <think>ongoing thought...';
      const clean3 = ChatViewProvider.stripThoughtTokens(middleUnclosed);
      assert.strictEqual(clean3, 'Prefix text', 'Thought text extending to end must be stripped');
    });

    it('should never persist internal reasoning tokens when saving agent mode result', async () => {
      const service = new OllamaService('http://127.0.0.1:11434');
      const { ChatViewProvider } = await import('../../src/providers/chatViewProvider');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, service);

      const historyUri = (provider as any)._getHistoryFileUri();
      assert.ok(historyUri);

      // Simulate an agent mode response with embedded reasoning
      const rawAgentResult = '<think>I should verify the build and finish.</think>Agent mode completed the assignment!';
      (provider as any)._chatHistory = [
        { role: 'user', content: 'Do task' },
        { role: 'assistant', content: ChatViewProvider.stripThoughtTokens(rawAgentResult) },
      ];
      await (provider as any)._saveChatHistoryToDisk();

      const diskBytes = await mockFs.readFile(historyUri);
      const diskText = new TextDecoder('utf-8').decode(diskBytes);
      assert.strictEqual(diskText.includes('<think>'), false, 'Persisted history on disk must not contain <think>');
      assert.strictEqual(diskText.includes('Internal reasoning'), false);
      assert.ok(diskText.includes('Agent mode completed the assignment!'));
    });
  });

  describe('8. Phase 5.5 H2: Swarm Whiteboard Schema v2, Task Isolation & Evidence Scoping', () => {
    it('should generate a unique taskId for every new task and reset executionPlan and modifiedFiles', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      (ollama as any).resolveModelForRole = (_r: any, fallback: string) => fallback;

      // Seed a legacy/previous whiteboard
      const fileUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/whiteboard.json');
      await mockFs.createDirectory(MockUri.joinPath(fileUri, '..'));
      const previousState = {
        version: 1,
        userObjective: 'Previous task objective',
        executionPlan: '1. Old step 2. Old step',
        scratchpad: 'Old scratchpad notes',
        activeAgent: 'orchestrator',
        delegationHistory: [{ from: 'orchestrator', to: 'coder', task: 'Old edit', timestamp: 123 }],
        modifiedFiles: ['src/oldFile.ts'],
        diagnostics: ['error: TS123'],
      };
      await mockFs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(previousState)));

      let turns = 0;
      ollama.chatWithTools = async (_model, _msgs, _tools) => {
        turns++;
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call_finish_${turns}`,
              function: {
                name: 'finish_task',
                arguments: { final_summary: 'New task finished clean.' },
              },
            },
          ],
        };
      };

      const orchestrator = new SwarmOrchestrator(ollama, {
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
        isContinuation: false,
      });

      const res = await orchestrator.runTask('Explain the architecture', {});
      assert.ok(res.includes('New task finished clean.'));

      // Check the in-memory and persisted whiteboard
      const wb = (orchestrator as any).whiteboard;
      assert.ok(wb.currentTask, 'Whiteboard must have currentTask object');
      assert.ok(wb.currentTask.taskId, 'Current task must have a unique taskId');
      assert.strictEqual(wb.version, 2, 'Whiteboard must adhere to Schema v2');
      assert.strictEqual(wb.currentTask.executionPlan, '', 'executionPlan must be empty for new task');
      assert.deepStrictEqual(wb.currentTask.modifiedFiles, [], 'modifiedFiles must be reset for new task');
      assert.deepStrictEqual(wb.currentTask.diagnostics, [], 'diagnostics must be reset for new task');
      assert.strictEqual(wb.currentTask.delegationHistory.length, 0, 'delegationHistory must be empty for new task');
      assert.ok(wb.lastTask, 'Previous task must be saved to lastTask snapshot');
      assert.strictEqual(wb.lastTask.userObjective, 'Previous task objective');
    });

    it('should allow read-only task to finish immediately without being trapped by previous task modified files', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      (ollama as any).resolveModelForRole = (_r: any, fallback: string) => fallback;

      // Seed previous whiteboard where files were modified
      const fileUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/whiteboard.json');
      await mockFs.createDirectory(MockUri.joinPath(fileUri, '..'));
      const previousState = {
        version: 2,
        activeTaskId: 'task_prev_123',
        currentTask: {
          taskId: 'task_prev_123',
          userObjective: 'Refactor auth',
          executionPlan: 'Old plan',
          scratchpad: 'Old scratchpad',
          modifiedFiles: ['src/auth.ts', 'src/token.ts'],
          diagnostics: [],
          delegationHistory: [],
          completed: true,
          updatedAt: Date.now(),
        },
      };
      await mockFs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(previousState)));

      let turnCount = 0;
      ollama.chatWithTools = async (_model, _msgs, _tools) => {
        turnCount++;
        // Attempt to finish task right away (read-only query)
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_read_finish',
              function: {
                name: 'finish_task',
                arguments: { final_summary: 'Explanation of auth delivered.' },
              },
            },
          ],
        };
      };

      const orchestrator = new SwarmOrchestrator(ollama, {
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
        isContinuation: false, // New task!
      });

      const res = await orchestrator.runTask('What does auth do?', {});
      assert.strictEqual(turnCount, 1, 'Read-only task should complete in 1 turn without tester trap');
      assert.ok(res.includes('Explanation of auth delivered.'));
    });

    it('should restore task-local state and preserve taskId when isContinuation is true', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      (ollama as any).resolveModelForRole = (_r: any, fallback: string) => fallback;

      const fileUri = MockUri.file('C:/Projects/test-workspace/.vscode/local-copilot/whiteboard.json');
      await mockFs.createDirectory(MockUri.joinPath(fileUri, '..'));
      const activeTaskSnapshot = {
        taskId: 'task_continuation_test_456',
        userObjective: 'Ongoing multi-turn task',
        executionPlan: 'Step 1 done. Step 2 in progress.',
        scratchpad: 'Work-in-progress notes',
        modifiedFiles: ['src/service.ts'],
        diagnostics: [],
        delegationHistory: [{ from: 'orchestrator', to: 'coder', task: 'Implement part 1', timestamp: 100 }],
        completed: false,
        updatedAt: Date.now(),
      };
      const savedV2 = {
        version: 2,
        activeTaskId: 'task_continuation_test_456',
        currentTask: activeTaskSnapshot,
      };
      await mockFs.writeFile(fileUri, new TextEncoder().encode(JSON.stringify(savedV2)));

      ollama.chatWithTools = async (_model, _msgs, _tools) => {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_cont_finish',
              function: {
                name: 'finish_task',
                arguments: { final_summary: 'Continued task finished.' },
              },
            },
          ],
        };
      };

      const orchestrator = new SwarmOrchestrator(ollama, {
        userModel: 'qwen2.5-coder:7b',
        availableModels: ['qwen2.5-coder:7b'],
        isContinuation: true, // Resume!
      });

      const res = await orchestrator.runTask('Continue task', {});
      const wb = (orchestrator as any).whiteboard;
      assert.strictEqual(wb.currentTask.taskId, 'task_continuation_test_456', 'Must preserve ongoing taskId');
      assert.strictEqual(wb.currentTask.executionPlan, 'Step 1 done. Step 2 in progress.');
      assert.deepStrictEqual(wb.currentTask.modifiedFiles, ['src/service.ts']);
      assert.strictEqual(wb.currentTask.delegationHistory.length, 1);
    });
  });
});
