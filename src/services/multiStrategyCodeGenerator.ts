import * as crypto from 'crypto';

export type PatchStrategyTier = 'exact_str_replace' | 'normalized_whitespace' | 'anchor_block_replace';

export interface MultiStrategyPatchResult {
  success: boolean;
  content: string;
  tierUsed?: PatchStrategyTier;
  preImageHash: string;
  postImageHash: string;
  error?: string;
}

export class MultiStrategyCodeGenerator {
  /**
   * Applies patch using a 3-tier fallback pipeline:
   * Tier 1: Exact string replacement
   * Tier 2: Whitespace-normalized line replacement
   * Tier 3: Anchor-based boundary replacement
   */
  public static applyPatch(
    originalContent: string,
    target: string,
    replacement: string
  ): MultiStrategyPatchResult {
    const preHash = this._hash(originalContent);

    // ==================== TIER 1: EXACT MATCH ====================
    const exactOccurrences = this._countOccurrences(originalContent, target);
    if (exactOccurrences === 1) {
      const patched = originalContent.replace(target, replacement);
      return {
        success: true,
        content: patched,
        tierUsed: 'exact_str_replace',
        preImageHash: preHash,
        postImageHash: this._hash(patched)
      };
    }

    if (exactOccurrences > 1) {
      // Ambiguous: Cannot safely use simple str_replace
      // Fall through to Tier 3 or return error
    }

    // ==================== TIER 2: NORMALIZED WHITESPACE / CRLF ====================
    const normalizedResult = this._applyNormalizedWhitespace(originalContent, target, replacement);
    if (normalizedResult.success) {
      return {
        success: true,
        content: normalizedResult.content,
        tierUsed: 'normalized_whitespace',
        preImageHash: preHash,
        postImageHash: this._hash(normalizedResult.content)
      };
    }

    // ==================== TIER 3: ANCHOR-BASED BLOCK REPLACEMENT ====================
    const anchorResult = this._applyAnchorBlock(originalContent, target, replacement);
    if (anchorResult.success) {
      return {
        success: true,
        content: anchorResult.content,
        tierUsed: 'anchor_block_replace',
        preImageHash: preHash,
        postImageHash: this._hash(anchorResult.content)
      };
    }

    return {
      success: false,
      content: originalContent,
      preImageHash: preHash,
      postImageHash: preHash,
      error: `All 3 patch strategies failed. Exact occurrences: ${exactOccurrences}. Could not find matching target even with normalized whitespace or block anchors.`
    };
  }

  private static _countOccurrences(source: string, sub: string): number {
    if (!sub) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = source.indexOf(sub, pos)) !== -1) {
      count++;
      pos += sub.length;
    }
    return count;
  }

  private static _applyNormalizedWhitespace(
    source: string,
    target: string,
    replacement: string
  ): { success: boolean; content: string } {
    // Normalize newlines to \n and trim trailing line spaces for line-by-line matching
    const sourceLines = source.split(/\r?\n/);
    const targetLines = target.split(/\r?\n/).map(l => l.trimEnd());
    const replacementLines = replacement.split(/\r?\n/);

    if (targetLines.length === 0) return { success: false, content: source };

    // Slide over source lines
    let matchIdx = -1;
    let matchCount = 0;

    for (let i = 0; i <= sourceLines.length - targetLines.length; i++) {
      let isMatch = true;
      for (let j = 0; j < targetLines.length; j++) {
        if (sourceLines[i + j].trimEnd() !== targetLines[j]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        matchIdx = i;
        matchCount++;
      }
    }

    if (matchCount === 1 && matchIdx !== -1) {
      const isCRLF = source.includes('\r\n');
      const delimiter = isCRLF ? '\r\n' : '\n';
      const before = sourceLines.slice(0, matchIdx);
      const after = sourceLines.slice(matchIdx + targetLines.length);
      const patched = [...before, ...replacementLines, ...after].join(delimiter);
      return { success: true, content: patched };
    }

    return { success: false, content: source };
  }

  private static _applyAnchorBlock(
    source: string,
    target: string,
    replacement: string
  ): { success: boolean; content: string } {
    const targetLines = target.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (targetLines.length < 2) return { success: false, content: source };

    const firstAnchor = targetLines[0];
    const lastAnchor = targetLines[targetLines.length - 1];

    const sourceLines = source.split(/\r?\n/);
    let startLine = -1;
    let endLine = -1;

    for (let i = 0; i < sourceLines.length; i++) {
      if (sourceLines[i].trim() === firstAnchor) {
        startLine = i;
        for (let j = i + 1; j < sourceLines.length; j++) {
          if (sourceLines[j].trim() === lastAnchor) {
            endLine = j;
            break;
          }
        }
        if (endLine !== -1) break;
      }
    }

    if (startLine !== -1 && endLine !== -1 && endLine >= startLine) {
      const isCRLF = source.includes('\r\n');
      const delimiter = isCRLF ? '\r\n' : '\n';
      const before = sourceLines.slice(0, startLine);
      const after = sourceLines.slice(endLine + 1);
      const replacementLines = replacement.split(/\r?\n/);
      const patched = [...before, ...replacementLines, ...after].join(delimiter);
      return { success: true, content: patched };
    }

    return { success: false, content: source };
  }

  private static _hash(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex');
  }
}
