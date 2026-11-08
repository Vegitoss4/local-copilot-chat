import * as path from 'path';

/**
 * File extension categorizations for fence sanitization policy.
 */
const DOC_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.rst',
  '.txt',
  '.adoc',
  '.asciidoc',
]);

export interface SanitizationResult {
  sanitized: string;
  hasInteriorFences: boolean;
  strippedOuterWrapper: boolean;
  warning?: string;
}

/**
 * Strips outer markdown code fence wrapper (```[lang] ... ```) and surrounding prose,
 * while strictly preserving interior content, line endings (CRLF/LF), and file-specific semantics.
 */
export function stripMarkdownFences(content: string, filePath?: string): SanitizationResult {
  if (!content) {
    return {
      sanitized: '',
      hasInteriorFences: false,
      strippedOuterWrapper: false,
    };
  }

  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  const isDocFile = DOC_EXTENSIONS.has(ext);

  // Detect CRLF vs LF
  const hasCRLF = content.includes('\r\n');
  const eol = hasCRLF ? '\r\n' : '\n';

  // Normalize lines for inspection while maintaining content
  const lines = content.split(/\r?\n/);

  // Find first and last non-empty line indices
  let firstNonEmptyIdx = -1;
  let lastNonEmptyIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      if (firstNonEmptyIdx === -1) {
        firstNonEmptyIdx = i;
      }
      lastNonEmptyIdx = i;
    }
  }

  if (firstNonEmptyIdx === -1) {
    // All whitespace
    return {
      sanitized: content,
      hasInteriorFences: false,
      strippedOuterWrapper: false,
    };
  }

  // Check if first non-empty line is an opening fence: ```[optional lang]
  const fenceOpenRegex = /^```[a-zA-Z0-9_\-\.]*\s*$/;
  const fenceCloseRegex = /^```\s*$/;

  let strippedOuterWrapper = false;
  let effectiveLines = lines;

  const firstLineTrimmed = lines[firstNonEmptyIdx].trim();
  const lastLineTrimmed = lines[lastNonEmptyIdx].trim();

  const CODE_START_KEYWORD_REGEX = /^(import|export|using|namespace|public|private|protected|internal|class|interface|struct|record|function|const|let|var|def\s|package\s|#include|<!DOCTYPE|<[a-zA-Z])/i;

  if (fenceOpenRegex.test(firstLineTrimmed) && fenceCloseRegex.test(lastLineTrimmed) && firstNonEmptyIdx < lastNonEmptyIdx) {
    // Strip strictly outer wrapper: lines between firstNonEmptyIdx + 1 and lastNonEmptyIdx - 1
    effectiveLines = lines.slice(firstNonEmptyIdx + 1, lastNonEmptyIdx);
    strippedOuterWrapper = true;
  } else if (!isDocFile && !CODE_START_KEYWORD_REGEX.test(firstLineTrimmed)) {
    // Check if there is an outer fence wrapper surrounded by conversational prose
    let outerFenceStart = -1;
    let outerFenceEnd = -1;
    let fenceOpenCount = 0;
    let fenceCloseCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (fenceOpenRegex.test(trimmed)) {
        if (outerFenceStart === -1) {
          outerFenceStart = i;
          fenceOpenCount++;
        } else if (fenceCloseRegex.test(trimmed)) {
          outerFenceEnd = i;
          fenceCloseCount++;
        }
      }
    }

    if (
      outerFenceStart !== -1 &&
      outerFenceEnd !== -1 &&
      outerFenceStart < outerFenceEnd &&
      fenceOpenCount === 1 &&
      fenceCloseCount === 1
    ) {
      effectiveLines = lines.slice(outerFenceStart + 1, outerFenceEnd);
      strippedOuterWrapper = true;
    }
  }

  const sanitized = effectiveLines.join(eol);

  // Check for interior fence lines
  let hasInteriorFences = false;
  for (let i = 0; i < effectiveLines.length; i++) {
    const trimmed = effectiveLines[i].trim();
    if (fenceOpenRegex.test(trimmed) || fenceCloseRegex.test(trimmed)) {
      hasInteriorFences = true;
      break;
    }
  }

  let warning: string | undefined;
  if (hasInteriorFences && !isDocFile) {
    warning = `File "${filePath || 'unknown'}" contains interior Markdown fence lines (e.g. inside template literal or comment). Verify content before applying.`;
  }

  return {
    sanitized,
    hasInteriorFences,
    strippedOuterWrapper,
    warning,
  };
}

/**
 * Deterministic validation check:
 * For source/config files, rejects content if the first or last non-empty line is a fence line.
 * For markdown/documentation files, interior fences are valid and allowed.
 */
export function assertNoFenceLines(content: string, filePath: string): void {
  if (!content) return;

  const ext = path.extname(filePath).toLowerCase();
  const isDocFile = DOC_EXTENSIONS.has(ext);

  if (isDocFile) {
    // In markdown/docs, interior code fences are legitimate
    return;
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;

  const fenceLineRegex = /^```[a-zA-Z0-9_\-\.]*\s*$/;

  const firstLine = lines[0].trim();
  const lastLine = lines[lines.length - 1].trim();

  if (fenceLineRegex.test(firstLine)) {
    throw new Error(
      `Fence Sanitization Failure: Source file "${filePath}" begins with an unstripped Markdown fence line: "${firstLine}". Write rejected to prevent code corruption.`
    );
  }

  if (fenceLineRegex.test(lastLine)) {
    throw new Error(
      `Fence Sanitization Failure: Source file "${filePath}" ends with an unstripped Markdown fence line: "${lastLine}". Write rejected to prevent code corruption.`
    );
  }
}
