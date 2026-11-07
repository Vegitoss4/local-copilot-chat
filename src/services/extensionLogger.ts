import * as vscode from 'vscode';

export interface LogContext {
  genId?: string;
  turnId?: string;
  component?: string;
}

export class ExtensionLogger {
  private static _instance: ExtensionLogger | undefined;
  private _outputChannel?: vscode.OutputChannel;

  // Patterns for credential and secret redaction
  private static readonly SECRET_PATTERNS: RegExp[] = [
    // Bearer and Basic tokens
    /Bearer\s+([^\s"']+)/gi,
    /Basic\s+([^\s"']+)/gi,
    // Well-known API key formats (OpenAI, GitHub, AWS, Anthropic, Slack)
    /\b(sk-[a-zA-Z0-9_\-]{20,})\b/g,
    /\b(ghp_[a-zA-Z0-9]{20,})\b/g,
    /\b(AKIA[0-9A-Z]{16})\b/g,
    /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/g,
    // Key/value secret assignments (e.g. password=..., api_key: "...", secret = '...')
    /(?:password|passwd|secret|api[_-]?key|token|auth[_-]?token)\s*[:=]\s*["']?([^"' \r\n]{4,})["']?/gi,
  ];

  constructor(outputChannel?: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  public static getInstance(outputChannel?: vscode.OutputChannel): ExtensionLogger {
    if (!ExtensionLogger._instance) {
      ExtensionLogger._instance = new ExtensionLogger(outputChannel);
    } else if (outputChannel && !ExtensionLogger._instance._outputChannel) {
      ExtensionLogger._instance._outputChannel = outputChannel;
    }
    return ExtensionLogger._instance;
  }

  public static resetInstance(): void {
    ExtensionLogger._instance = undefined;
  }

  public setOutputChannel(channel: vscode.OutputChannel): void {
    this._outputChannel = channel;
  }

  /**
   * Redacts sensitive secrets, passwords, Bearer tokens and API keys from text.
   */
  public static redact(text: string): string {
    if (!text || typeof text !== 'string') return text;
    let redacted = text;

    for (const pattern of this.SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, (match, ...args) => {
        const captured = typeof args[0] === 'string' ? args[0] : undefined;
        if (captured) {
          const idx = match.lastIndexOf(captured);
          if (idx !== -1) {
            return match.slice(0, idx) + '[REDACTED]' + match.slice(idx + captured.length);
          }
        }
        return '[REDACTED]';
      });
    }

    return redacted;
  }

  private _formatPrefix(level: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const ids: string[] = [];
    if (context?.component) ids.push(context.component);
    if (context?.genId) ids.push(`Gen:${context.genId}`);
    if (context?.turnId) ids.push(`Turn:${context.turnId}`);
    const tag = ids.length > 0 ? ` [${ids.join(' ')}]` : '';
    return `[${timestamp}] [${level}]${tag}`;
  }

  public info(message: string, context?: LogContext): void {
    const safeMsg = ExtensionLogger.redact(message);
    const line = `${this._formatPrefix('INFO', context)} ${safeMsg}`;
    this._outputChannel?.appendLine(line);
  }

  public warn(message: string, context?: LogContext): void {
    const safeMsg = ExtensionLogger.redact(message);
    const line = `${this._formatPrefix('WARN', context)} ${safeMsg}`;
    this._outputChannel?.appendLine(line);
  }

  public error(message: string | Error, context?: LogContext): void {
    const rawMsg = message instanceof Error ? (message.stack || message.message) : message;
    const safeMsg = ExtensionLogger.redact(rawMsg);
    const line = `${this._formatPrefix('ERROR', context)} ${safeMsg}`;
    this._outputChannel?.appendLine(line);
  }

  public debug(message: string, context?: LogContext): void {
    const safeMsg = ExtensionLogger.redact(message);
    const line = `${this._formatPrefix('DEBUG', context)} ${safeMsg}`;
    this._outputChannel?.appendLine(line);
  }
}
