import * as assert from 'assert';
import { AgentTerminalProvider } from '../../src/terminal/agentTerminalProvider';
import { SessionEngine } from '../../src/services/sessionEngine';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState, setMockWorkspaceFolders, MockUri } from '../mocks/vscodeMock';

describe('Deliverable 11.1: Interactive Agent Pseudoterminal Suite', () => {
  let mockOllamaService: any;
  let sessionEngine: SessionEngine;
  let terminalProvider: AgentTerminalProvider;
  let writtenData: string[];
  const tempDir = 'C:\\Projects\\test-workspace';

  beforeEach(() => {
    resetMockState(tempDir);
    setMockWorkspaceFolders([
      { name: 'terminal-workspace', uri: MockUri.file(tempDir), index: 0 }
    ]);

    SessionEngine.resetInstance();
    mockOllamaService = {
      streamChat: async (
        model: string,
        messages: any[],
        onChunk: (chunk: string) => void
      ) => {
        onChunk('Terminal response text');
        return 'Terminal response text';
      }
    };

    sessionEngine = new SessionEngine(mockOllamaService as unknown as OllamaService);
    terminalProvider = new AgentTerminalProvider(sessionEngine);

    writtenData = [];
    terminalProvider.onDidWrite((data) => {
      writtenData.push(data);
    });
  });

  afterEach(() => {
    sessionEngine.stopGeneration();
    SessionEngine.resetInstance();
  });

  describe('Terminal Lifecycle & Banner Rendering', () => {
    it('should emit welcome banner and mode prompt on open', () => {
      terminalProvider.open(undefined);
      const output = writtenData.join('');

      assert.ok(output.includes('Jarvis: Autonomous Agent Terminal'));
      assert.ok(output.includes('qwen2.5-coder:7b'));
      assert.ok(output.includes('[chat]>'));
    });

    it('should fire onDidClose when close is called', (done) => {
      terminalProvider.onDidClose(() => {
        done();
      });
      terminalProvider.close();
    });
  });

  describe('Terminal Escape Sequence & Injection Sanitization', () => {
    it('should neutralize malicious OSC sequences such as clipboard exfiltration or title spoofing', () => {
      const maliciousOSC = 'Hello \x1b]52;c;c2VjcmV0\x07World \x1b]0;Spoofed Title\x1b\\Done';
      const clean = AgentTerminalProvider.sanitizeTerminalOutput(maliciousOSC);

      assert.ok(!clean.includes('c2VjcmV0'));
      assert.ok(!clean.includes('Spoofed Title'));
      assert.strictEqual(clean, 'Hello World Done');
    });

    it('should convert standard newlines into CRLF for terminal compatibility', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      const clean = AgentTerminalProvider.sanitizeTerminalOutput(input);
      assert.strictEqual(clean, 'Line 1\r\nLine 2\r\nLine 3');
    });
  });

  describe('Keyboard Input & Line Editing', () => {
    it('should buffer typed characters and write them to the terminal', () => {
      terminalProvider.open(undefined);
      writtenData = [];

      terminalProvider.handleInput('h');
      terminalProvider.handleInput('i');

      assert.deepStrictEqual(writtenData, ['h', 'i']);
    });

    it('should handle backspace correctly by modifying buffer and erasing character', () => {
      terminalProvider.open(undefined);
      writtenData = [];

      terminalProvider.handleInput('a');
      terminalProvider.handleInput('b');
      terminalProvider.handleInput('\x7f'); // backspace

      const output = writtenData.join('');
      // Should erase line with ANSI_ERASE_LINE and re-render 'a' without 'b'
      assert.ok(output.includes('\x1b[2K\r'));
      assert.ok(output.includes('a'));
    });

    it('should submit buffer to SessionEngine on Enter', async () => {
      terminalProvider.open(undefined);
      writtenData = [];

      terminalProvider.handleInput('p');
      terminalProvider.handleInput('i');
      terminalProvider.handleInput('n');
      terminalProvider.handleInput('g');
      terminalProvider.handleInput('\r'); // Enter

      // Wait for turn completion
      await new Promise(r => setTimeout(r, 20));

      const output = writtenData.join('');
      assert.ok(output.includes('Terminal response text'));
      assert.ok(output.includes('Turn completed'));
    });

    it('should switch mode via /mode command in terminal', () => {
      terminalProvider.open(undefined);
      writtenData = [];

      terminalProvider.handleInput('/');
      terminalProvider.handleInput('m');
      terminalProvider.handleInput('o');
      terminalProvider.handleInput('d');
      terminalProvider.handleInput('e');
      terminalProvider.handleInput(' ');
      terminalProvider.handleInput('a');
      terminalProvider.handleInput('g');
      terminalProvider.handleInput('e');
      terminalProvider.handleInput('n');
      terminalProvider.handleInput('t');
      terminalProvider.handleInput('\r');

      assert.strictEqual(sessionEngine.getMode(), 'agent');
      const output = writtenData.join('');
      assert.ok(output.includes('Switched mode to: AGENT'));
    });

    it('should handle Ctrl+C to clear current line or stop generation', () => {
      terminalProvider.open(undefined);
      writtenData = [];

      terminalProvider.handleInput('some half-typed input');
      terminalProvider.handleInput('\x03'); // Ctrl+C

      const output = writtenData.join('');
      assert.ok(output.includes('^C'));
    });
  });

  describe('Interactive Approval Prompts', () => {
    it('should prompt for tool approval and resolve with true on "y" response', async () => {
      terminalProvider.open(undefined);
      writtenData = [];

      let approvalResolved: boolean | undefined;

      // Trigger approval via engine event listener
      const approvalPromise = new Promise<boolean>((resolve) => {
        // Simulate engine firing onRequestApproval
        (sessionEngine as any)._events.onRequestApproval?.({
          id: 'app-01',
          tool: 'writeFile',
          description: 'Modify src/index.ts',
          params: {}
        });
        sessionEngine.resolveApproval = (id: string, approved: boolean) => {
          approvalResolved = approved;
          resolve(approved);
        };
      });

      const promptOutput = writtenData.join('');
      assert.ok(promptOutput.includes('Approval Required'));
      assert.ok(promptOutput.includes('[y/N]:'));

      // User types 'y' + Enter
      terminalProvider.handleInput('y');
      terminalProvider.handleInput('\r');

      const approved = await approvalPromise;
      assert.strictEqual(approved, true);
      assert.strictEqual(approvalResolved, true);
    });

    it('should deny approval on Ctrl+C or non-y response', async () => {
      terminalProvider.open(undefined);
      writtenData = [];

      let approvalResolved: boolean | undefined;

      const approvalPromise = new Promise<boolean>((resolve) => {
        (sessionEngine as any)._events.onRequestApproval?.({
          id: 'app-02',
          tool: 'executeCommand',
          description: 'npm test',
          params: {}
        });
        sessionEngine.resolveApproval = (id: string, approved: boolean) => {
          approvalResolved = approved;
          resolve(approved);
        };
      });

      terminalProvider.handleInput('n');
      terminalProvider.handleInput('\r');

      const approved = await approvalPromise;
      assert.strictEqual(approved, false);
      assert.strictEqual(approvalResolved, false);
    });
  });
});
