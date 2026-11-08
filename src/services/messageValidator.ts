import { CommandClassifier, CommandTier } from './commandClassifier';

export interface ValidatedWebviewMessage {
  type: string;
  payload: any;
}

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

export class MessageValidator {
  private static readonly ALLOWED_TYPES = new Set([
    'webviewLog',
    'fetchModels',
    'sendMessage',
    'agentReply',
    'toolApprovalResponse',
    'stopGeneration',
    'getSelection',
    'getActiveFile',
    'getWorkspaceContext',
    'insertCode',
    'createFile',
    'copyToClipboard',
    'runCommand',
    'clearChat',
    'applyCodeBlock',
    'switchModeAndRun',
    'enableEmbeddedFallback',
  ]);

  /**
   * Strictly validates incoming message payload from Webview.
   * Throws MessageValidationError if payload is malformed or unauthorized.
   */
  public static validate(raw: any): ValidatedWebviewMessage {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MessageValidationError('Malformed message: payload must be an object.');
    }

    if (typeof raw.type !== 'string' || !raw.type.trim()) {
      throw new MessageValidationError("Malformed message: 'type' must be a non-empty string.");
    }

    const type = raw.type.trim();

    if (!this.ALLOWED_TYPES.has(type)) {
      throw new MessageValidationError(`Unauthorized message type: '${type}'.`);
    }

    switch (type) {
      case 'webviewLog': {
        const message = typeof raw.message === 'string' ? raw.message : String(raw.message || '');
        const level = typeof raw.level === 'string' ? raw.level : 'info';
        return { type, payload: { level, message } };
      }

      case 'sendMessage': {
        if (typeof raw.text !== 'string' || !raw.text.trim()) {
          throw new MessageValidationError("'sendMessage' requires non-empty string 'text'.");
        }
        const mode = (raw.mode === 'agent' || raw.isAgent === true) ? 'agent' : 'chat';
        const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : 'auto';
        const autonomousMode = typeof raw.autonomousMode === 'boolean' ? raw.autonomousMode : true;
        return {
          type,
          payload: { text: raw.text, mode, model, autonomousMode }
        };
      }

      case 'agentReply': {
        if (typeof raw.text !== 'string') {
          throw new MessageValidationError("'agentReply' requires string 'text'.");
        }
        return { type, payload: { text: raw.text } };
      }

      case 'toolApprovalResponse': {
        if (typeof raw.id !== 'string' || !raw.id.trim()) {
          throw new MessageValidationError("'toolApprovalResponse' requires string 'id'.");
        }
        return { type, payload: { id: raw.id, approved: raw.approved === true } };
      }

      case 'insertCode': {
        if (typeof raw.code !== 'string') {
          throw new MessageValidationError("'insertCode' requires string 'code'.");
        }
        return { type, payload: { code: raw.code } };
      }

      case 'createFile': {
        if (typeof raw.fileName !== 'string' || !raw.fileName.trim()) {
          throw new MessageValidationError("'createFile' requires string 'fileName'.");
        }
        if (typeof raw.code !== 'string') {
          throw new MessageValidationError("'createFile' requires string 'code'.");
        }
        return { type, payload: { fileName: raw.fileName.trim(), code: raw.code } };
      }

      case 'applyCodeBlock': {
        if (typeof raw.messageId !== 'string' || !raw.messageId.trim()) {
          throw new MessageValidationError("'applyCodeBlock' requires non-empty string 'messageId'.");
        }
        if (typeof raw.blockIndex !== 'number' || !Number.isInteger(raw.blockIndex) || raw.blockIndex < 0) {
          throw new MessageValidationError("'applyCodeBlock' requires non-negative integer 'blockIndex'.");
        }
        return {
          type,
          payload: {
            messageId: raw.messageId.trim(),
            blockIndex: raw.blockIndex,
          },
        };
      }

      case 'switchModeAndRun': {
        if (raw.targetMode !== 'agent' && raw.targetMode !== 'chat') {
          throw new MessageValidationError("'switchModeAndRun' requires targetMode 'agent' or 'chat'.");
        }
        return {
          type,
          payload: {
            targetMode: raw.targetMode,
            prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
          },
        };
      }

      case 'enableEmbeddedFallback': {
        const allowedKeys = new Set(['type', 'model']);
        for (const k of Object.keys(raw)) {
          if (!allowedKeys.has(k)) {
            throw new MessageValidationError(`Unexpected field '${k}' in enableEmbeddedFallback.`);
          }
        }
        if (raw.model !== undefined && typeof raw.model !== 'string') {
          throw new MessageValidationError("'enableEmbeddedFallback' requires string 'model' if present.");
        }
        return {
          type,
          payload: {
            model: typeof raw.model === 'string' ? raw.model.trim() : undefined,
          },
        };
      }

      case 'copyToClipboard': {
        if (typeof raw.text !== 'string') {
          throw new MessageValidationError("'copyToClipboard' requires string 'text'.");
        }
        return { type, payload: { text: raw.text } };
      }

      case 'runCommand': {
        if (typeof raw.command !== 'string' || !raw.command.trim()) {
          throw new MessageValidationError("'runCommand' requires non-empty string 'command'.");
        }
        const command = raw.command.trim();
        // Security gate: validate that command is not prohibited Tier 4
        try {
          const classification = CommandClassifier.classify(command);
          if (classification.tier === CommandTier.TIER_4_PROHIBITED) {
            throw new MessageValidationError(
              `Terminal execution prohibited: ${classification.reason}`
            );
          }
        } catch (err: any) {
          if (err instanceof MessageValidationError) throw err;
          throw new MessageValidationError(`Invalid command syntax: ${err.message}`);
        }
        return { type, payload: { command } };
      }

      case 'fetchModels':
      case 'stopGeneration':
      case 'getSelection':
      case 'getActiveFile':
      case 'getWorkspaceContext':
      case 'clearChat':
        return { type, payload: {} };

      default:
        throw new MessageValidationError(`Unhandled message type: '${type}'.`);
    }
  }
}
