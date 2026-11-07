import * as vscode from 'vscode';
import { SessionEngine, SessionMode } from '../services/sessionEngine';
import { ApprovalRequest, ProgressEvent } from '../services/autonomousAgent';
import { ToolCall, ToolResult } from '../services/agentToolService';

/**
 * Deliverable 11.1: Interactive Agent Pseudoterminal
 * Implements VS Code Pseudoterminal API to provide a Claude Code-style
 * interactive terminal experience powered by SessionEngine.
 */

// ANSI Escape Codes
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
const ANSI_ERASE_LINE = '\x1b[2K\r';

export class AgentTerminalProvider implements vscode.Pseudoterminal {
  private _writeEmitter = new vscode.EventEmitter<string>();
  public readonly onDidWrite: vscode.Event<string> = this._writeEmitter.event;

  private _closeEmitter = new vscode.EventEmitter<number | void>();
  public readonly onDidClose: vscode.Event<number | void> = this._closeEmitter.event;

  private _sessionEngine: SessionEngine;
  private _inputBuffer: string = '';
  private _cursorPos: number = 0;
  private _history: string[] = [];
  private _historyIndex: number = -1;
  private _isAwaitingApproval: boolean = false;
  private _currentApprovalId?: string;
  private _isAwaitingUserInput: boolean = false;

  constructor(sessionEngine: SessionEngine) {
    this._sessionEngine = sessionEngine;
    this._wireEngineListeners();
  }

  /**
   * Sanitizes text to neutralize terminal escape sequences (OSC injection, clipboard exfiltration, title spoofing).
   */
  public static sanitizeTerminalOutput(text: string): string {
    if (!text) return '';
    return text
      // Neutralize OSC escape sequences: ESC ] ... (ST | BEL)
      .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, '')
      // Neutralize DCS and APC sequences: ESC P / ESC _
      .replace(/\x1b[P_][\s\S]*?(?:\x1b\\|\x07)/g, '')
      // Strip dangerous CSI sequences like cursor hide or device status requests
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
      // Preserve standard newlines with CRLF for pseudoterminal
      .replace(/(?<!\r)\n/g, '\r\n');
  }

  public open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    this._writeBanner();
    this._writePrompt();
  }

  public close(): void {
    this._closeEmitter.fire();
  }

  private _write(text: string): void {
    this._writeEmitter.fire(text);
  }

  private _writeLine(text: string): void {
    this._writeEmitter.fire(text + '\r\n');
  }

  private _writeBanner(): void {
    const model = this._sessionEngine.getModel();
    const mode = this._sessionEngine.getMode();
    this._writeLine(`${ANSI_BOLD}${ANSI_CYAN}====================================================${ANSI_RESET}`);
    this._writeLine(`${ANSI_BOLD}${ANSI_CYAN}  Local Copilot: Claude Code-Level Agent Terminal   ${ANSI_RESET}`);
    this._writeLine(`${ANSI_DIM}  Model: ${model} | Mode: ${mode.toUpperCase()} | 8 GB Local First${ANSI_RESET}`);
    this._writeLine(`${ANSI_DIM}  Type /help for slash commands, Ctrl+C to cancel turn${ANSI_RESET}`);
    this._writeLine(`${ANSI_BOLD}${ANSI_CYAN}====================================================${ANSI_RESET}\r\n`);
  }

  private _writePrompt(): void {
    const mode = this._sessionEngine.getMode();
    const modeColor = mode === 'agent' ? ANSI_MAGENTA : (mode === 'plan' ? ANSI_YELLOW : ANSI_CYAN);
    this._write(`${ANSI_BOLD}${modeColor}[${mode}]>${ANSI_RESET} `);
  }

  private _wireEngineListeners(): void {
    this._sessionEngine.updateEventListeners({
      onStartStream: (payload) => {
        this._writeLine(`\r\n${ANSI_DIM}Thinking with ${payload.model}...${ANSI_RESET}\r\n`);
      },
      onToken: (chunk) => {
        const clean = AgentTerminalProvider.sanitizeTerminalOutput(chunk);
        this._write(clean);
      },
      onThought: (chunk) => {
        this._write(`${ANSI_DIM}${chunk}${ANSI_RESET}`);
      },
      onToolStart: (call: ToolCall) => {
        const name = call.function?.name || 'unknown';
        const args = JSON.stringify(call.function?.arguments || {});
        this._writeLine(`\r\n${ANSI_YELLOW}⚡ [Tool] Executing: ${name}${ANSI_RESET} ${ANSI_DIM}${args}${ANSI_RESET}`);
      },
      onToolEnd: (result: ToolResult) => {
        const status = result.success ? `${ANSI_GREEN}✓ Succeeded${ANSI_RESET}` : `${ANSI_RED}✗ Failed${ANSI_RESET}`;
        this._writeLine(`${status}: ${ANSI_DIM}${result.output || ''}${ANSI_RESET}`);
      },
      onAgentStatus: (status: string) => {
        this._writeLine(`${ANSI_CYAN}ℹ [Status] ${status}${ANSI_RESET}`);
      },
      onAgentProgress: (event: ProgressEvent) => {
        const role = event.agentRole ? `[${event.agentRole}] ` : '';
        this._writeLine(`${ANSI_DIM}${event.icon || '•'} ${role}${event.message}${ANSI_RESET}`);
      },
      onRequestApproval: (req: ApprovalRequest) => {
        this._isAwaitingApproval = true;
        this._currentApprovalId = req.id;
        this._writeLine(`\r\n${ANSI_BOLD}${ANSI_YELLOW}⚠️ Approval Required:${ANSI_RESET} ${req.description}`);
        this._write(`${ANSI_BOLD}Approve operation? [y/N]: ${ANSI_RESET}`);
      },
      onAskUser: (question: string) => {
        this._isAwaitingUserInput = true;
        this._writeLine(`\r\n${ANSI_BOLD}${ANSI_CYAN}❓ Agent Question:${ANSI_RESET} ${question}`);
        this._write(`${ANSI_BOLD}Answer: ${ANSI_RESET}`);
      },
      onStreamEnd: (_payload) => {
        this._writeLine(`\r\n${ANSI_GREEN}✓ Turn completed.${ANSI_RESET}\r\n`);
        this._writePrompt();
      },
      onStreamError: (err) => {
        this._writeLine(`\r\n${ANSI_RED}✗ Error: ${err}${ANSI_RESET}\r\n`);
        this._writePrompt();
      }
    });
  }

  /**
   * Handles keyboard input from the VS Code integrated terminal.
   */
  public handleInput(data: string): void {
    // 1. Interactive tool approval response
    if (this._isAwaitingApproval && this._currentApprovalId) {
      if (data === '\r' || data === '\n') {
        this._writeLine('');
        const approved = this._inputBuffer.trim().toLowerCase() === 'y' || this._inputBuffer.trim().toLowerCase() === 'yes';
        const id = this._currentApprovalId;
        this._isAwaitingApproval = false;
        this._currentApprovalId = undefined;
        this._inputBuffer = '';
        this._sessionEngine.resolveApproval(id, approved);
      } else if (data === '\x03') { // Ctrl+C
        this._writeLine('^C');
        const id = this._currentApprovalId;
        this._isAwaitingApproval = false;
        this._currentApprovalId = undefined;
        this._inputBuffer = '';
        this._sessionEngine.resolveApproval(id, false);
      } else if (data === '\x7f' || data === '\b') { // Backspace
        if (this._inputBuffer.length > 0) {
          this._inputBuffer = this._inputBuffer.slice(0, -1);
          this._write('\b \b');
        }
      } else if (data >= ' ') {
        this._inputBuffer += data;
        this._write(data);
      }
      return;
    }

    // 2. Interactive user question response
    if (this._isAwaitingUserInput) {
      if (data === '\r' || data === '\n') {
        this._writeLine('');
        const answer = this._inputBuffer.trim();
        this._isAwaitingUserInput = false;
        this._inputBuffer = '';
        this._sessionEngine.resolveUserAnswer(answer);
      } else if (data === '\x03') { // Ctrl+C
        this._writeLine('^C');
        this._isAwaitingUserInput = false;
        this._inputBuffer = '';
        this._sessionEngine.resolveUserAnswer('');
      } else if (data === '\x7f' || data === '\b') {
        if (this._inputBuffer.length > 0) {
          this._inputBuffer = this._inputBuffer.slice(0, -1);
          this._write('\b \b');
        }
      } else if (data >= ' ') {
        this._inputBuffer += data;
        this._write(data);
      }
      return;
    }

    // 3. Normal command input handling
    // Ctrl+C: Cancel active generation or clear current input line
    if (data === '\x03') {
      if (this._sessionEngine.isGenerating()) {
        this._writeLine('^C (Stopping generation...)');
        this._sessionEngine.stopGeneration();
      } else {
        this._writeLine('^C');
        this._inputBuffer = '';
        this._cursorPos = 0;
        this._writePrompt();
      }
      return;
    }

    // Ctrl+L: Clear screen
    if (data === '\x0c') {
      this._write(ANSI_CLEAR_SCREEN);
      this._writeBanner();
      this._writePrompt();
      this._write(this._inputBuffer);
      return;
    }

    // Enter / Return: Execute input
    if (data === '\r' || data === '\n') {
      this._writeLine('');
      const input = this._inputBuffer.trim();
      this._inputBuffer = '';
      this._cursorPos = 0;
      this._historyIndex = -1;

      if (!input) {
        this._writePrompt();
        return;
      }

      this._history.push(input);

      // Terminal-local commands
      if (input.toLowerCase() === '/clear') {
        this._write(ANSI_CLEAR_SCREEN);
        this._writeBanner();
        this._sessionEngine.clearHistory();
        this._writePrompt();
        return;
      }

      if (input.toLowerCase().startsWith('/mode')) {
        const parts = input.split(/\s+/);
        const targetMode = parts[1]?.toLowerCase() as SessionMode;
        if (targetMode === 'chat' || targetMode === 'agent' || targetMode === 'plan') {
          this._sessionEngine.setMode(targetMode);
          this._writeLine(`${ANSI_GREEN}✓ Switched mode to: ${targetMode.toUpperCase()}${ANSI_RESET}`);
        } else {
          this._writeLine(`${ANSI_YELLOW}Current mode: ${this._sessionEngine.getMode()}. Usage: /mode <chat|agent|plan>${ANSI_RESET}`);
        }
        this._writePrompt();
        return;
      }

      // Dispatch to session engine
      this._sessionEngine.sendMessage(input).catch((err) => {
        this._writeLine(`${ANSI_RED}Error: ${err.message || err}${ANSI_RESET}`);
        this._writePrompt();
      });
      return;
    }

    // Backspace: Delete previous character
    if (data === '\x7f' || data === '\b') {
      if (this._cursorPos > 0) {
        const left = this._inputBuffer.slice(0, this._cursorPos - 1);
        const right = this._inputBuffer.slice(this._cursorPos);
        this._inputBuffer = left + right;
        this._cursorPos--;
        this._refreshLine();
      }
      return;
    }

    // Arrow keys / ANSI sequences
    if (data.startsWith('\x1b[')) {
      const code = data.slice(2);
      // Up arrow: Previous history
      if (code === 'A') {
        if (this._history.length > 0 && this._historyIndex < this._history.length - 1) {
          this._historyIndex++;
          this._inputBuffer = this._history[this._history.length - 1 - this._historyIndex];
          this._cursorPos = this._inputBuffer.length;
          this._refreshLine();
        }
        return;
      }
      // Down arrow: Next history
      if (code === 'B') {
        if (this._historyIndex > 0) {
          this._historyIndex--;
          this._inputBuffer = this._history[this._history.length - 1 - this._historyIndex];
          this._cursorPos = this._inputBuffer.length;
          this._refreshLine();
        } else if (this._historyIndex === 0) {
          this._historyIndex = -1;
          this._inputBuffer = '';
          this._cursorPos = 0;
          this._refreshLine();
        }
        return;
      }
      // Right arrow: Move cursor right
      if (code === 'C') {
        if (this._cursorPos < this._inputBuffer.length) {
          this._cursorPos++;
          this._write('\x1b[C');
        }
        return;
      }
      // Left arrow: Move cursor left
      if (code === 'D') {
        if (this._cursorPos > 0) {
          this._cursorPos--;
          this._write('\x1b[D');
        }
        return;
      }
      return;
    }

    // Standard character typing
    if (data >= ' ') {
      const left = this._inputBuffer.slice(0, this._cursorPos);
      const right = this._inputBuffer.slice(this._cursorPos);
      this._inputBuffer = left + data + right;
      this._cursorPos += data.length;
      if (right.length > 0) {
        this._refreshLine();
      } else {
        this._write(data);
      }
    }
  }

  private _refreshLine(): void {
    this._write(ANSI_ERASE_LINE);
    this._writePrompt();
    this._write(this._inputBuffer);
    const offset = this._inputBuffer.length - this._cursorPos;
    if (offset > 0) {
      this._write(`\x1b[${offset}D`);
    }
  }
}
