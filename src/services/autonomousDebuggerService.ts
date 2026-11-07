import * as path from 'path';
import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { PathSecurity } from './pathSecurity';
import { WorkspaceManager } from './workspaceManager';
import { CodeGenerationEngine } from './codeGenerationEngine';
import { AgentToolService } from './agentToolService';

export type ErrorCategory =
  | 'null_pointer'
  | 'type_mismatch'
  | 'assertion_failure'
  | 'missing_export'
  | 'syntax_error'
  | 'runtime_exception';

export interface StackFrame {
  filePath: string;
  line: number;
  column?: number;
  functionName?: string;
  isWorkspaceFile: boolean;
}

export interface ParsedDiagnostic {
  rawError: string;
  category: ErrorCategory;
  message: string;
  frames: StackFrame[];
  primaryCulprit?: StackFrame;
}

export interface DebugHypothesis {
  id: string;
  category: ErrorCategory;
  summary: string;
  suggestedAction: string;
  targetFile?: string;
  targetLine?: number;
}

export interface DebugAnalysisResult {
  diagnostic: ParsedDiagnostic;
  hypotheses: DebugHypothesis[];
  reproductionCommand?: string;
}

export class AutonomousDebuggerService {
  /**
   * Parses raw error text, stack traces, compiler output, or test failures into a structured diagnostic.
   */
  public parseError(rawText: string, workspaceRoot?: string): ParsedDiagnostic {
    const trimmed = rawText.trim();
    const category = this._classifyErrorCategory(trimmed);
    const message = this._extractErrorMessage(trimmed);
    const frames = this._extractStackFrames(trimmed, workspaceRoot);

    // Primary culprit is the topmost workspace frame (not in node_modules or system)
    const primaryCulprit = frames.find(f => f.isWorkspaceFile) || frames[0];

    return {
      rawError: trimmed,
      category,
      message,
      frames,
      primaryCulprit
    };
  }

  /**
   * Generates actionable debug hypotheses and reproduction steps from a diagnostic.
   */
  public analyzeAndGenerateHypotheses(
    rawText: string,
    workspaceRoot?: string,
    testCommandHint?: string
  ): DebugAnalysisResult {
    const diagnostic = this.parseError(rawText, workspaceRoot);
    const hypotheses: DebugHypothesis[] = [];

    const file = diagnostic.primaryCulprit?.filePath;
    const line = diagnostic.primaryCulprit?.line;

    switch (diagnostic.category) {
      case 'null_pointer':
        hypotheses.push({
          id: 'hypo-null-guard',
          category: 'null_pointer',
          summary: 'Potential dereference of undefined or null object',
          suggestedAction: 'Add optional chaining (`?.`) or null-coalescing guard before property access',
          targetFile: file,
          targetLine: line
        });
        break;

      case 'assertion_failure':
        hypotheses.push({
          id: 'hypo-assertion-mismatch',
          category: 'assertion_failure',
          summary: 'Expected value does not match actual computation',
          suggestedAction: 'Verify input transformations and return values in the target function against test fixtures',
          targetFile: file,
          targetLine: line
        });
        break;

      case 'type_mismatch':
        hypotheses.push({
          id: 'hypo-type-contract',
          category: 'type_mismatch',
          summary: 'Type signature violation or incompatible argument types',
          suggestedAction: 'Check function argument types and return type annotations against callers',
          targetFile: file,
          targetLine: line
        });
        break;

      case 'missing_export':
        hypotheses.push({
          id: 'hypo-export-not-found',
          category: 'missing_export',
          summary: 'Imported identifier not exported from target module',
          suggestedAction: 'Ensure target file includes `export` keyword on the required identifier',
          targetFile: file,
          targetLine: line
        });
        break;

      case 'syntax_error':
        hypotheses.push({
          id: 'hypo-syntax-breakage',
          category: 'syntax_error',
          summary: 'Syntax error or unclosed token/delimiter',
          suggestedAction: 'Inspect file at the indicated line for missing braces, parentheses, or malformed syntax',
          targetFile: file,
          targetLine: line
        });
        break;

      default:
        hypotheses.push({
          id: 'hypo-general-exception',
          category: 'runtime_exception',
          summary: 'Unhandled runtime exception',
          suggestedAction: 'Inspect stack trace at primary culprit frame and wrap unsafe operations in error handling',
          targetFile: file,
          targetLine: line
        });
        break;
    }

    // Determine targeted reproduction command
    let reproductionCommand = testCommandHint;
    if (!reproductionCommand && file) {
      const baseName = path.basename(file);
      if (baseName.includes('.test.') || baseName.includes('.spec.')) {
        reproductionCommand = `npx mocha "${file}"`;
      }
    }

    return {
      diagnostic,
      hypotheses,
      reproductionCommand
    };
  }

  private _classifyErrorCategory(text: string): ErrorCategory {
    const lower = text.toLowerCase();
    if (lower.includes('cannot read property') || lower.includes('cannot read properties') || lower.includes('nullpointerexception') || lower.includes('attributeerror: \'nonetype\'')) {
      return 'null_pointer';
    }
    if (lower.includes('assertionerror') || lower.includes('expect(') || lower.includes('assert.strictEqual') || lower.includes('expected values to be strictly equal')) {
      return 'assertion_failure';
    }
    if (lower.includes('typeerror') || lower.includes('ts2345') || lower.includes('ts2322') || lower.includes('is not assignable to type')) {
      return 'type_mismatch';
    }
    if (lower.includes('is not exported from') || lower.includes('does not contain a default export') || lower.includes('cannot find module') || lower.includes('has no exported member')) {
      return 'missing_export';
    }
    if (lower.includes('syntaxerror') || lower.includes('unexpected token') || lower.includes('parsing error')) {
      return 'syntax_error';
    }
    return 'runtime_exception';
  }

  private _extractErrorMessage(text: string): string {
    const firstLine = text.split(/\r?\n/)[0].trim();
    return firstLine.replace(/^(Error|TypeError|AssertionError|SyntaxError):\s*/, '');
  }

  private _extractStackFrames(text: string, workspaceRoot?: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = text.split(/\r?\n/);
    const normWorkspaceRoot = workspaceRoot ? path.normalize(workspaceRoot).toLowerCase() : undefined;

    for (const line of lines) {
      const trimmed = line.trim();

      // Node / V8: at func (path/file.ts:12:34) or at path/file.ts:12:34 or at node:internal/timers:540:9
      const v8Match = trimmed.match(/^at\s+(?:([a-zA-Z0-9_$.<>]+)\s+\()?([a-zA-Z]:[\\\/][^:)]+|node:[^:)]+|[\\\/][^:)]+|[a-zA-Z0-9_.\-\\\/]+):(\d+)(?::(\d+))?\)?/);
      if (v8Match) {
        const functionName = v8Match[1];
        const rawFilePath = path.normalize(v8Match[2]);
        const lineNum = parseInt(v8Match[3], 10);
        const colNum = v8Match[4] ? parseInt(v8Match[4], 10) : undefined;

        const isWorkspace = this._isWorkspacePath(rawFilePath, normWorkspaceRoot);
        frames.push({
          filePath: rawFilePath,
          line: lineNum,
          column: colNum,
          functionName,
          isWorkspaceFile: isWorkspace
        });
        continue;
      }

      // TypeScript compiler error: src/file.ts(12,34): error TS2345: ...
      const tsMatch = trimmed.match(/^([a-zA-Z0-9_.\-\\\/]+)\((\d+),(\d+)\):\s*error\s*(TS\d+):/);
      if (tsMatch) {
        const rawFilePath = path.normalize(tsMatch[1]);
        const lineNum = parseInt(tsMatch[2], 10);
        const colNum = parseInt(tsMatch[3], 10);
        const isWorkspace = this._isWorkspacePath(rawFilePath, normWorkspaceRoot);

        frames.push({
          filePath: rawFilePath,
          line: lineNum,
          column: colNum,
          functionName: tsMatch[4],
          isWorkspaceFile: isWorkspace
        });
        continue;
      }

      // Python traceback: File "path/file.py", line 12, in func
      const pyMatch = trimmed.match(/^File\s+["']([^"']+)["'],\s+line\s+(\d+)(?:,\s+in\s+([a-zA-Z0-9_]+))?/);
      if (pyMatch) {
        const rawFilePath = path.normalize(pyMatch[1]);
        const lineNum = parseInt(pyMatch[2], 10);
        const functionName = pyMatch[3];
        const isWorkspace = this._isWorkspacePath(rawFilePath, normWorkspaceRoot);

        frames.push({
          filePath: rawFilePath,
          line: lineNum,
          functionName,
          isWorkspaceFile: isWorkspace
        });
        continue;
      }
    }

    return frames;
  }

  private _isWorkspacePath(filePath: string, normWorkspaceRoot?: string): boolean {
    const lower = filePath.toLowerCase();
    // Exclude node_modules, internal node core, and python stdlib
    if (lower.includes('node_modules') || lower.includes('node:internal') || lower.includes('site-packages')) {
      return false;
    }
    if (normWorkspaceRoot) {
      return lower.startsWith(normWorkspaceRoot);
    }
    return true;
  }

  /**
   * Executes a bounded, safe autonomous debugging workflow for /fix
   */
  public static async executeFixWorkflow(
    errorInput: string,
    ollamaService: OllamaService,
    model: string,
    onProgress: (statusMsg: string) => void,
    signal?: AbortSignal,
    targetRootUri?: vscode.Uri
  ): Promise<{ success: boolean; message: string; verified: boolean }> {
    const debuggerInst = new AutonomousDebuggerService();
    const folder = WorkspaceManager.getTargetWorkspaceFolder(targetRootUri);
    const rootFsPath = folder ? folder.uri.fsPath : undefined;

    let targetError = errorInput.trim();

    // If no explicit error provided, check active editor diagnostics or run build check
    if (!targetError) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const diags = vscode.languages.getDiagnostics(activeEditor.document.uri);
        const errorDiag = diags.find(d => d.severity === vscode.DiagnosticSeverity.Error);
        if (errorDiag) {
          targetError = `${activeEditor.document.uri.fsPath}(${errorDiag.range.start.line + 1},${errorDiag.range.start.character + 1}): error: ${errorDiag.message}`;
        }
      }
    }

    if (!targetError) {
      onProgress('🔍 No error text provided. Checking workspace build status...');
      const buildCheck = await AgentToolService.checkBuild();
      if (!buildCheck.success) {
        targetError = buildCheck.output;
      } else {
        return {
          success: true,
          message: 'Build succeeded and no active editor diagnostics detected. Nothing to fix!',
          verified: true
        };
      }
    }

    onProgress(`🩺 **Autonomous Diagnostic Analysis**\nAnalyzing defect symptoms...`);
    const analysis = debuggerInst.analyzeAndGenerateHypotheses(targetError, rootFsPath);
    onProgress(`Category: **${analysis.diagnostic.category}**\nPrimary Culprit: \`${analysis.diagnostic.primaryCulprit ? path.basename(analysis.diagnostic.primaryCulprit.filePath) : 'unknown'}\``);

    if (!analysis.diagnostic.primaryCulprit) {
      return {
        success: false,
        message: `Could not localize error to a workspace file. Diagnostic message: ${analysis.diagnostic.message}`,
        verified: false
      };
    }

    const culprit = analysis.diagnostic.primaryCulprit;
    if (PathSecurity.isSensitiveTarget(culprit.filePath)) {
      return {
        success: false,
        message: `Culprit file "${culprit.filePath}" is classified as a sensitive target (.git, CI workflow, or system config). Autonomous fixing is disabled for sensitive targets.`,
        verified: false
      };
    }
    let validatedCulprit;
    try {
      validatedCulprit = PathSecurity.validatePath(culprit.filePath, folder || undefined);
    } catch (e: any) {
      return {
        success: false,
        message: `Culprit file path access denied: ${e.message}`,
        verified: false
      };
    }

    // Read source context around the culprit line
    let sourceContent = '';
    try {
      const fileBytes = await vscode.workspace.fs.readFile(validatedCulprit.uri);
      sourceContent = new TextDecoder('utf-8').decode(fileBytes);
    } catch (e: any) {
      return {
        success: false,
        message: `Failed to read source file "${culprit.filePath}": ${e.message}`,
        verified: false
      };
    }

    onProgress(`🤖 Requesting minimal surgical patch from model: **${model}**...`);
    const prompt = `You are an expert autonomous debugger. Fix this defect with the minimal surgical replacement.
Error Message:
${analysis.diagnostic.rawError}

Primary Culprit File: ${culprit.filePath} (line ${culprit.line})

Source Code:
\`\`\`
${sourceContent.slice(0, 4000)}
\`\`\`

Generate a surgical string replacement in this exact format:
\`\`\`patch
SEARCH:
<exact code lines to replace>
REPLACE:
<fixed code lines>
\`\`\``;

    let response = '';
    await ollamaService.streamChat(
      model,
      [
        { role: 'system', content: 'You are a precise coding debugger. Output only the requested patch format.' },
        { role: 'user', content: prompt }
      ],
      (chunk) => {
        response += chunk;
      },
      signal
    );

    // Parse SEARCH and REPLACE blocks
    const patchMatch = response.match(/SEARCH:\s*([\s\S]*?)\s*REPLACE:\s*([\s\S]*?)(?:```|$)/);
    if (!patchMatch) {
      return {
        success: false,
        message: `Model suggested diagnostic guidance but did not produce an applicable surgical patch:\n\n${response}`,
        verified: false
      };
    }

    const searchStr = patchMatch[1].trim();
    const replaceStr = patchMatch[2].trim();

    onProgress(`⚙️ Applying patch transactionally via CodeGenerationEngine...`);
    const engine = new CodeGenerationEngine(folder ? folder.uri : undefined);
    const patchResult = await engine.applyTransactionalPatches([
      {
        filePath: culprit.filePath,
        type: 'modify',
        oldString: searchStr,
        newString: replaceStr
      }
    ], async () => {
      // Post-verification hook: check build
      onProgress(`🔬 Running post-fix verification build check...`);
      const check = await AgentToolService.checkBuild();
      if (!check.success) {
        return { valid: false, error: check.output };
      }
      return { valid: true };
    });

    if (patchResult.success) {
      onProgress(`✅ Fix applied and verified by build check!`);
      return {
        success: true,
        message: `Defect fixed successfully in \`${path.basename(culprit.filePath)}\` and verified cleanly.`,
        verified: true
      };
    } else {
      onProgress(`⚠️ Proposed fix could not be applied or failed build check: ${patchResult.error}`);
      return {
        success: false,
        message: `Proposed fix rolled back: ${patchResult.error}`,
        verified: false
      };
    }
  }
}
