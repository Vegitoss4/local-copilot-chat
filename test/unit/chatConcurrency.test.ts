import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/chatViewProvider';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, MockUri } from '../mocks/vscodeMock';

describe('Phase 5.5 H2: ChatViewProvider Concurrency & Single-Flight Guard Suite', () => {
  const testRoot = 'C:/Projects/test-workspace';

  beforeEach(() => {
    resetMockState(testRoot);
  });

  it('should reject a second concurrent sendMessage with streamError and preserve active generation', async () => {
    const ollama = new OllamaService('http://127.0.0.1:11434');

    // Simulate an LLM stream that takes some time to yield
    let streamRelease: () => void;
    const streamPromise = new Promise<void>((resolve) => {
      streamRelease = resolve;
    });

    ollama.streamChat = async (
      _model: string,
      _msgs: any[],
      onChunk: (chunk: string) => void,
      _signal?: AbortSignal
    ): Promise<string> => {
      onChunk('Processing first message...');
      await streamPromise;
      onChunk(' done!');
      return 'Processing first message... done!';
    };

    const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);

    const postedMessages: any[] = [];
    let messageHandler: ((data: any) => Promise<void>) | undefined;

    const mockWebview = {
      options: {},
      html: '',
      onDidReceiveMessage: (handler: any) => {
        messageHandler = handler;
        return { dispose: () => {} };
      },
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
      },
    };

    provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);
    assert.ok(messageHandler);

    // 1. Dispatch first sendMessage
    const firstMsgPromise = messageHandler({
      type: 'sendMessage',
      text: 'First slow message',
      mode: 'chat',
      model: 'qwen2.5-coder:7b',
      autonomousMode: true,
    });

    // Wait a brief moment to ensure first message has started generating
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual((provider as any)._isGenerating, true, 'Provider should be in generating state');

    // 2. Dispatch second sendMessage while first is still generating
    await messageHandler({
      type: 'sendMessage',
      text: 'Second overlapping message',
      mode: 'chat',
      model: 'qwen2.5-coder:7b',
      autonomousMode: true,
    });

    // Verify streamError was posted for the second message
    const errMsgs = postedMessages.filter((m) => m.type === 'streamError');
    assert.strictEqual(errMsgs.length, 1, 'Should post streamError rejecting concurrent message');
    assert.ok(
      errMsgs[0].error.includes('already in progress'),
      `Expected error about generation in progress, got: ${errMsgs[0].error}`
    );

    // Verify conversation history does NOT contain the second message
    const history = (provider as any)._chatHistory;
    const foundSecond = history.some((h: any) => h.content === 'Second overlapping message');
    assert.strictEqual(foundSecond, false, 'Rejected message must not be appended to chat history');

    // 3. Release and complete first stream
    streamRelease!();
    await firstMsgPromise;

    // Verify first message finished and _isGenerating is cleanly reset
    assert.strictEqual((provider as any)._isGenerating, false, 'Generating state must reset after completion');
    const streamEndCount = postedMessages.filter((m) => m.type === 'streamEnd').length;
    assert.strictEqual(streamEndCount, 1, 'Should dispatch exactly one streamEnd for first message');
  });

  it('should allow agentReply message while generation is in progress', async () => {
    const ollama = new OllamaService('http://127.0.0.1:11434');
    const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);

    const postedMessages: any[] = [];
    let messageHandler: ((data: any) => Promise<void>) | undefined;

    const mockWebview = {
      options: {},
      html: '',
      onDidReceiveMessage: (handler: any) => {
        messageHandler = handler;
        return { dispose: () => {} };
      },
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
      },
    };

    provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);
    assert.ok(messageHandler);

    // Set generating state and mock pending answer resolver (ask_user workflow)
    (provider as any)._isGenerating = true;
    let resolvedReply = '';
    (provider as any)._pendingUserAnswerResolver = (ans: string) => {
      resolvedReply = ans;
    };

    // Dispatch agentReply
    await messageHandler({
      type: 'agentReply',
      text: 'User clarification answer',
    });

    assert.strictEqual(
      resolvedReply,
      'User clarification answer',
      'agentReply should resolve pending user answer even while isGenerating is true'
    );
  });

  it('should abort stream and cleanly unlock generation lock via finally when stopGeneration is dispatched', async () => {
    const ollama = new OllamaService('http://127.0.0.1:11434');

    ollama.streamChat = async (
      _model: string,
      _msgs: any[],
      onChunk: (chunk: string) => void,
      signal?: AbortSignal
    ): Promise<string> => {
      onChunk('Starting streaming work...');
      // Wait until aborted
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return reject(err);
        }
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      return 'done';
    };

    const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);
    const postedMessages: any[] = [];
    let messageHandler: ((data: any) => Promise<void>) | undefined;
    const mockWebview = {
      options: {},
      html: '',
      onDidReceiveMessage: (handler: any) => {
        messageHandler = handler;
        return { dispose: () => {} };
      },
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
      },
    };

    provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

    // Start generation A
    const genPromise = messageHandler!({
      type: 'sendMessage',
      text: 'Long running task A',
      mode: 'chat',
      model: 'qwen2.5-coder:7b',
      autonomousMode: true,
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual((provider as any)._isGenerating, true, 'Generation A should be generating');

    // Trigger stopGeneration
    await messageHandler!({ type: 'stopGeneration' });

    // Wait for Gen A promise to complete its finally block
    await genPromise;

    // Verify Gen A completed cleanup cleanly
    assert.strictEqual((provider as any)._isGenerating, false, 'Generation lock should be unlocked by Gen A finally');
    assert.ok(postedMessages.some((m) => m.type === 'streamAborted'), 'Should dispatch streamAborted');
    assert.ok(postedMessages.some((m) => m.type === 'streamEnd'), 'Should dispatch streamEnd');
  });

  it('should guarantee earlier aborted generation does not clobber newer generation state or premature release', async () => {
    const ollama = new OllamaService('http://127.0.0.1:11434');

    let genAUnwindResolver: () => void;
    const genAUnwindPromise = new Promise<void>((resolve) => {
      genAUnwindResolver = resolve;
    });

    let genBUnwindResolver: () => void;
    const genBUnwindPromise = new Promise<void>((resolve) => {
      genBUnwindResolver = resolve;
    });

    let currentTurn: any = 'none';

    ollama.streamChat = async (
      _model: string,
      msgs: any[],
      onChunk: (chunk: string) => void,
      signal?: AbortSignal
    ): Promise<string> => {
      const isGenA = msgs[msgs.length - 1]?.content === 'Task A';
      if (isGenA) {
        currentTurn = 'GenA';
        onChunk('Chunk A');
        // Wait for abort and then wait for manual release
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve());
        });
        // Delay unwinding to simulate slow tool cleanup
        await genAUnwindPromise;
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      } else {
        currentTurn = 'GenB';
        onChunk('Chunk B');
        await genBUnwindPromise;
        return 'Result B';
      }
    };

    const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);
    const postedMessages: any[] = [];
    let messageHandler: ((data: any) => Promise<void>) | undefined;
    const mockWebview = {
      options: {},
      html: '',
      onDidReceiveMessage: (handler: any) => {
        messageHandler = handler;
        return { dispose: () => {} };
      },
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
      },
    };

    provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

    // 1. Start Gen A
    const genAPromise = messageHandler!({
      type: 'sendMessage',
      text: 'Task A',
      mode: 'chat',
      model: 'qwen2.5-coder:7b',
    });

    while ((currentTurn as string) !== 'GenA') {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok((currentTurn as string) === 'GenA');
    const genAId = (provider as any)._currentGenerationId;

    // 2. Abort Gen A via stop
    await messageHandler!({ type: 'stopGeneration' });

    // Manually start Gen B (simulating user clicking send or a new turn)
    // To allow Gen B to start while Gen A is slow unwinding:
    (provider as any)._isGenerating = false; // simulate release if forced
    const genBPromise = messageHandler!({
      type: 'sendMessage',
      text: 'Task B',
      mode: 'chat',
      model: 'qwen2.5-coder:7b',
    });

    while ((currentTurn as string) !== 'GenB') {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok((currentTurn as string) === 'GenB');
    const genBId = (provider as any)._currentGenerationId;
    assert.notStrictEqual(genAId, genBId, 'Gen B must have distinct generationId');

    // 3. Now let Gen A finally unwind
    genAUnwindResolver!();
    await genAPromise;

    // 4. Verify Gen A's finally did NOT reset _isGenerating or clear Gen B's abort controller
    assert.strictEqual(
      (provider as any)._currentGenerationId,
      genBId,
      'Active generation must remain Gen B'
    );
    assert.strictEqual((provider as any)._isGenerating, true, 'Gen B should still be generating');
    assert.ok(
      (provider as any)._currentAbortController !== undefined,
      "Gen B's controller must not be cleared by Gen A"
    );

    // 5. Complete Gen B
    genBUnwindResolver!();
    await genBPromise;
    assert.strictEqual((provider as any)._isGenerating, false, 'Gen B completion must reset lock');
  });

  describe('Phase 5.5 H3: Host-Side Terminal Approval & Workspace Trust Suite', () => {
    it('should require host-side modal confirmation for Tier 2 commands in runCommand', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);

      let messageHandler: ((data: any) => Promise<void>) | undefined;
      const mockWebview = {
        options: {},
        html: '',
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
          return { dispose: () => {} };
        },
        postMessage: async () => {},
      };

      provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

      // Track modal warning calls
      let modalPrompted = false;
      let modalOptions: any = null;
      let executedCommand: string | null = null;

      (vscode.window as any).terminals = [];
      (vscode.window as any).createTerminal = (name: string) => ({
        name,
        show: () => {},
        sendText: (cmd: string) => {
          executedCommand = cmd;
        },
        dispose: () => {},
      });

      (vscode.window as any).showWarningMessage = async (_msg: string, options: any, ...items: string[]) => {
        modalPrompted = true;
        modalOptions = options;
        return 'Execute Command';
      };

      await messageHandler!({
        type: 'runCommand',
        command: 'npm test',
      });

      assert.strictEqual(modalPrompted, true, 'Tier 2 command must prompt host modal confirmation');
      assert.strictEqual(modalOptions?.modal, true, 'Dialog must be modal');
      assert.strictEqual(executedCommand, 'npm test', 'Command should execute after user confirmation');
    });

    it('should fail closed when modal confirmation is cancelled or dismissed', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);

      let messageHandler: ((data: any) => Promise<void>) | undefined;
      const mockWebview = {
        options: {},
        html: '',
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
          return { dispose: () => {} };
        },
        postMessage: async () => {},
      };

      provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

      let executed = false;
      (vscode.window as any).terminals = [];
      (vscode.window as any).createTerminal = (name: string) => ({
        name,
        show: () => {},
        sendText: () => {
          executed = true;
        },
        dispose: () => {},
      });

      (vscode.window as any).showWarningMessage = async () => {
        // User clicks Cancel or presses Esc
        return undefined;
      };

      await messageHandler!({
        type: 'runCommand',
        command: 'dotnet run',
      });

      assert.strictEqual(executed, false, 'Command must not execute when dialog is dismissed');
    });

    it('should block terminal command execution completely in untrusted workspaces', async () => {
      const ollama = new OllamaService('http://127.0.0.1:11434');
      const provider = new ChatViewProvider(MockUri.file('C:/ext') as any, ollama);

      let messageHandler: ((data: any) => Promise<void>) | undefined;
      const mockWebview = {
        options: {},
        html: '',
        onDidReceiveMessage: (handler: any) => {
          messageHandler = handler;
          return { dispose: () => {} };
        },
        postMessage: async () => {},
      };

      provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

      let errorShown = '';
      (vscode.window as any).showErrorMessage = (msg: string) => {
        errorShown = msg;
      };

      // Set workspace as untrusted
      (vscode.workspace as any).isTrusted = false;

      let executed = false;
      (vscode.window as any).terminals = [];
      (vscode.window as any).createTerminal = (name: string) => ({
        name,
        show: () => {},
        sendText: () => {
          executed = true;
        },
        dispose: () => {},
      });

      await messageHandler!({
        type: 'runCommand',
        command: 'npm test',
      });

      assert.strictEqual(executed, false, 'Command execution must be blocked in untrusted workspace');
      assert.ok(errorShown.includes('Untrusted'), `Expected untrusted error, got: ${errorShown}`);

      // Restore workspace trust for remaining tests
      (vscode.workspace as any).isTrusted = true;
    });
  });
});
