import * as vscode from 'vscode';
import { SessionEngine, SessionMode } from '../services/sessionEngine';

/**
 * Deliverable 11.8: Status Bar & Accessibility Provider
 * Displays real-time model, mode, and context-window utilization metrics
 * in the VS Code status bar with visual thresholds and accessibility controls.
 */

export interface StatusBarMetrics {
  model: string;
  mode: SessionMode;
  usedTokens: number;
  maxTokens: number;
  isGenerating: boolean;
}

export class StatusBarProvider implements vscode.Disposable {
  private static _instance: StatusBarProvider | undefined;
  private _statusBarItem: vscode.StatusBarItem;
  private _sessionEngine: SessionEngine;
  private _metrics: StatusBarMetrics;
  private _disposables: vscode.Disposable[] = [];

  constructor(sessionEngine: SessionEngine) {
    this._sessionEngine = sessionEngine;
    this._metrics = {
      model: sessionEngine.getModel(),
      mode: sessionEngine.getMode(),
      usedTokens: 0,
      maxTokens: 8192,
      isGenerating: false
    };

    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this._statusBarItem.command = 'localCopilot.showStatusMenu';
    this._disposables.push(this._statusBarItem);

    this._registerCommands();
    this._wireEngineListeners();
    this.refresh();
    this._statusBarItem.show();
  }

  public static getInstance(sessionEngine?: SessionEngine): StatusBarProvider {
    if (!this._instance) {
      if (!sessionEngine) {
        throw new Error('SessionEngine required to initialize StatusBarProvider.');
      }
      this._instance = new StatusBarProvider(sessionEngine);
    }
    return this._instance;
  }

  public static resetInstance(): void {
    if (this._instance) {
      this._instance.dispose();
      this._instance = undefined;
    }
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this._statusBarItem;
  }

  public updateMetrics(partial: Partial<StatusBarMetrics>): void {
    this._metrics = { ...this._metrics, ...partial };
    this.refresh();
  }

  /**
   * Refreshes status bar text, color, and tooltip based on metrics.
   */
  public refresh(): void {
    const { model, mode, usedTokens, maxTokens, isGenerating } = this._metrics;
    const pct = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;

    const icon = isGenerating ? '$(sync~spin)' : '$(sparkle)';
    const shortModel = model.split(':')[0] || model;
    const modeUpper = mode.toUpperCase();

    this._statusBarItem.text = `${icon} Copilot: ${shortModel} [${modeUpper}] ${pct}%`;

    // Visual warning thresholds: green <= 80%, yellow > 80%, red > 90%
    if (pct > 90) {
      this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this._statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    } else if (pct > 80) {
      this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this._statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.color = undefined;
    }

    // Comprehensive accessible tooltip
    const statusText = isGenerating ? 'Generating response...' : 'Idle';
    this._statusBarItem.tooltip = new vscode.MarkdownString(
      `**Jarvis Assistant**\n\n` +
      `- **Model**: \`${model}\`\n` +
      `- **Mode**: \`${modeUpper}\`\n` +
      `- **Status**: ${statusText}\n` +
      `- **Context**: ${usedTokens} / ${maxTokens} tokens (${pct}%)\n\n` +
      `*Click to switch mode, model, or open agent terminal.*`
    );
  }

  private _wireEngineListeners(): void {
    this._sessionEngine.updateEventListeners({
      onStartStream: (p) => {
        this.updateMetrics({
          model: p.model,
          mode: p.mode,
          isGenerating: true
        });
      },
      onStreamEnd: () => {
        const history = this._sessionEngine.getHistory();
        const totalChars = history.reduce((acc, m) => acc + (m.content || '').length, 0);
        const estTokens = Math.ceil(totalChars / 4);
        this.updateMetrics({
          usedTokens: estTokens,
          isGenerating: false
        });
      },
      onStreamError: () => {
        this.updateMetrics({ isGenerating: false });
      },
      onHistoryUpdated: (history) => {
        const totalChars = history.reduce((acc, m) => acc + (m.content || '').length, 0);
        const estTokens = Math.ceil(totalChars / 4);
        this.updateMetrics({
          usedTokens: estTokens
        });
      }
    });
  }

  private _registerCommands(): void {
    const cmd = vscode.commands.registerCommand('localCopilot.showStatusMenu', async () => {
      const items: vscode.QuickPickItem[] = [
        {
          label: '$(comment-discussion) Switch to Chat Mode',
          description: 'Conversational assistance and Q&A'
        },
        {
          label: '$(shield) Switch to Plan Mode',
          description: 'Read-only architectural analysis without code execution'
        },
        {
          label: '$(organization) Switch to Agent Mode',
          description: 'Autonomous multi-agent execution with tools'
        },
        {
          label: '$(terminal) Open Agent Terminal',
          description: 'Open interactive CLI pseudoterminal'
        },
        {
          label: '$(trash) Clear Conversation History',
          description: 'Reset active session history'
        }
      ];

      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: `Jarvis (Current: ${this._metrics.mode.toUpperCase()})`
      });

      if (!chosen) return;

      if (chosen.label.includes('Chat Mode')) {
        this._sessionEngine.setMode('chat');
        this.updateMetrics({ mode: 'chat' });
      } else if (chosen.label.includes('Plan Mode')) {
        this._sessionEngine.setMode('plan');
        this.updateMetrics({ mode: 'plan' });
      } else if (chosen.label.includes('Agent Mode')) {
        this._sessionEngine.setMode('agent');
        this.updateMetrics({ mode: 'agent' });
      } else if (chosen.label.includes('Agent Terminal')) {
        vscode.commands.executeCommand('localCopilot.openTerminal');
      } else if (chosen.label.includes('Clear Conversation')) {
        await this._sessionEngine.clearHistory();
        this.updateMetrics({ usedTokens: 0 });
      }
    });

    this._disposables.push(cmd);
  }

  public dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}
