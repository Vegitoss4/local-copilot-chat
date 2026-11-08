import * as vscode from 'vscode';
import * as path from 'path';
import { PathSecurity } from './pathSecurity';
import { CodeGenerationEngine, FilePatchOperation, TransactionalEditResult } from './codeGenerationEngine';
import { stripMarkdownFences, assertNoFenceLines } from './fenceSanitizer';

export interface StructuredEditParseResult {
  valid: boolean;
  operations: FilePatchOperation[];
  warnings: string[];
  error?: string;
}

export class StructuredEditFallback {
  public static readonly SYSTEM_INSTRUCTION = `You are an AI code editor operating in structured-edit mode.
You must output file modifications strictly using one of these three block formats:

Format 1: Create a new file or replace an entire file
FILE: path/to/file.ext
\`\`\`language
<full file content>
\`\`\`

Format 2: Surgical search and replace within an existing file
FILE: path/to/file.ext
${'<' + '<<<<<< SEARCH'}
<exact existing lines to replace>
${'=' + '======'}
<replacement lines>
${'>' + '>>>>>> REPLACE'}

Format 3: Delete an existing file
DELETE_FILE: path/to/file.ext

Rules:
- Specify relative workspace paths only.
- Never output Markdown fences around SEARCH/REPLACE blocks.
- The SEARCH block must match the existing file content exactly, including whitespace.
- Do not repeat the same file path in multiple blocks in a single turn.`;

  /**
   * Parses structured edits from model text and strictly validates schema constraints.
   */
  public static parseBlocks(
    responseText: string,
    workspaceRootUri?: vscode.Uri
  ): StructuredEditParseResult {
    const operations: FilePatchOperation[] = [];
    const warnings: string[] = [];
    const seenPaths = new Set<string>();

    if (!responseText || !responseText.trim()) {
      return { valid: false, operations: [], warnings: [], error: 'Response content is empty.' };
    }

    // 1. Parse DELETE_FILE commands
    const deleteRegex = /^DELETE_FILE:\s*([^\r\n]+)$/gm;
    let delMatch: RegExpExecArray | null;
    while ((delMatch = deleteRegex.exec(responseText)) !== null) {
      const filePath = delMatch[1].trim();
      if (!filePath) continue;

      const norm = filePath.replace(/\\/g, '/').toLowerCase();
      if (seenPaths.has(norm)) {
        return {
          valid: false,
          operations: [],
          warnings,
          error: `Duplicate file path "${filePath}" detected in structured edit response.`,
        };
      }
      seenPaths.add(norm);

      // Path security check
      try {
        const validated = PathSecurity.validatePath(filePath, workspaceRootUri);
        if (PathSecurity.isSensitiveTarget(filePath)) {
          return {
            valid: false,
            operations: [],
            warnings,
            error: `Security Violation: Target path "${filePath}" is a protected sensitive file.`,
          };
        }
      } catch (err: any) {
        return {
          valid: false,
          operations: [],
          warnings,
          error: `Path validation failed for "${filePath}": ${err.message}`,
        };
      }

      operations.push({
        filePath,
        type: 'delete',
      });
    }

    // 2. Parse SEARCH / REPLACE blocks
    // Format: FILE: <path>\s*<<<<<<< SEARCH\n<old>\n=======\n<new>\n>>>>>>> REPLACE
    const searchReplaceRegex = /FILE:\s*([^\r\n]+)\s*[\r\n]+<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
    let srMatch: RegExpExecArray | null;
    while ((srMatch = searchReplaceRegex.exec(responseText)) !== null) {
      const filePath = srMatch[1].trim();
      const oldString = srMatch[2];
      const newString = srMatch[3];

      const norm = filePath.replace(/\\/g, '/').toLowerCase();
      if (seenPaths.has(norm)) {
        return {
          valid: false,
          operations: [],
          warnings,
          error: `Duplicate file path "${filePath}" detected in structured edit response.`,
        };
      }
      seenPaths.add(norm);

      // Validate path security
      try {
        const validated = PathSecurity.validatePath(filePath, workspaceRootUri);
        if (PathSecurity.isSensitiveTarget(filePath)) {
          return {
            valid: false,
            operations: [],
            warnings,
            error: `Security Violation: Target path "${filePath}" is a protected sensitive file.`,
          };
        }
      } catch (err: any) {
        return {
          valid: false,
          operations: [],
          warnings,
          error: `Path validation failed for "${filePath}": ${err.message}`,
        };
      }

      // Check interior fence lines
      const { warning: fenceWarn } = stripMarkdownFences(newString, filePath);
      if (fenceWarn) {
        warnings.push(fenceWarn);
      }

      operations.push({
        filePath,
        type: 'modify',
        oldString,
        newString,
      });
    }

    // 3. Parse Full File Content (Create/Overwrite) blocks
    // Format: FILE: <path>\s*```[lang]?\r?\n<content>\r?\n```
    const createFileRegex = /FILE:\s*([^\r\n]+)\s*[\r\n]+```[a-zA-Z0-9_\-\.]*\r?\n([\s\S]*?)\r?\n```/g;
    let cfMatch: RegExpExecArray | null;
    while ((cfMatch = createFileRegex.exec(responseText)) !== null) {
      const filePath = cfMatch[1].trim();
      const rawContent = cfMatch[2];

      const norm = filePath.replace(/\\/g, '/').toLowerCase();
      if (seenPaths.has(norm)) {
        // If already parsed as a SEARCH/REPLACE block, reject
        return {
          valid: false,
          operations: [],
          warnings,
          error: `Duplicate file path "${filePath}" detected in structured edit response.`,
        };
      }
      seenPaths.add(norm);

      // Path security check
      try {
        const validated = PathSecurity.validatePath(filePath, workspaceRootUri, { allowNewFile: true });
        if (PathSecurity.isSensitiveTarget(filePath)) {
          return {
            valid: false,
            operations: [],
            warnings,
            error: `Security Violation: Target path "${filePath}" is a protected sensitive file.`,
          };
        }
      } catch (err: any) {
        return {
          valid: false,
          operations: [],
          warnings,
          error: `Path validation failed for "${filePath}": ${err.message}`,
        };
      }

      const { sanitized, warning: fenceWarn } = stripMarkdownFences(rawContent, filePath);
      try {
        assertNoFenceLines(sanitized, filePath);
      } catch (fenceErr: any) {
        return {
          valid: false,
          operations: [],
          warnings,
          error: fenceErr.message,
        };
      }

      if (fenceWarn) {
        warnings.push(fenceWarn);
      }

      operations.push({
        filePath,
        type: 'create',
        content: sanitized,
      });
    }

    if (operations.length === 0) {
      return {
        valid: false,
        operations: [],
        warnings,
        error: 'No valid structured-edit blocks (CREATE, SEARCH/REPLACE, or DELETE_FILE) found in response.',
      };
    }

    return {
      valid: true,
      operations,
      warnings,
    };
  }

  /**
   * Applies validated structured edits transactionally via CodeGenerationEngine.
   */
  public static async applyStructuredEdits(
    parseResult: StructuredEditParseResult,
    workspaceRootUri?: vscode.Uri
  ): Promise<TransactionalEditResult> {
    if (!parseResult.valid || parseResult.operations.length === 0) {
      return {
        success: false,
        appliedOperations: 0,
        rolledBack: false,
        modifiedFiles: [],
        error: parseResult.error || 'No valid operations to apply.',
      };
    }

    const engine = new CodeGenerationEngine(workspaceRootUri);
    return await engine.applyTransactionalPatches(parseResult.operations);
  }
}
