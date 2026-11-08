import * as vscode from 'vscode';
import { OllamaService, ChatMessage } from './ollamaService';
import { ExtensionLogger } from './extensionLogger';

/**
 * Deliverable 12.3: Context-Window Optimization & Prefix Caching
 * - Monitors /api/ps telemetry to detect partial CPU offload and warn about throughput cliffs.
 * - Enforces byte-level prefix-cache stability (system prompt + tool schemas + repo map)
 *   so Ollama reuses its KV prompt cache across consecutive turns.
 * - Profiles effective context limits under 8 GB VRAM.
 */

export interface CpuOffloadStatus {
  isOffloaded: boolean;
  modelTag: string;
  totalSizeBytes: number;
  vramSizeBytes: number;
  cpuSpilloverBytes: number;
  gpuOffloadRatio: number; // 0.0 - 1.0 (1.0 = 100% on GPU)
  warningMessage?: string;
}

export interface PrefixCacheVerificationResult {
  isStable: boolean;
  prefixLengthChars: number;
  divergenceIndex?: number;
  divergenceReason?: string;
}

export class ContextOptimizationService {
  private static readonly LOGGER_TAG = 'ContextOptimization';

  /**
   * Queries /api/ps on Ollama to detect if any model layers or KV cache spilled to CPU.
   */
  public static async checkCpuOffload(
    ollamaService?: OllamaService
  ): Promise<CpuOffloadStatus | null> {
    try {
      const service = ollamaService || new OllamaService();
      const runningModels = await service.getLoadedModels();
      if (!runningModels || runningModels.length === 0) {
        return null;
      }

      const active = runningModels[0];
      const totalSize = active.size || 0;
      const vramSize = active.sizeVram ?? active.size;

      if (totalSize === 0) {
        return null;
      }

      const gpuRatio = Math.min(1.0, Math.round((vramSize / totalSize) * 100) / 100);
      const isOffloaded = vramSize < totalSize;
      const spillover = Math.max(0, totalSize - vramSize);

      let warningMessage: string | undefined;
      if (isOffloaded) {
        const spilloverMb = Math.round(spillover / (1024 * 1024));
        const totalMb = Math.round(totalSize / (1024 * 1024));
        warningMessage = `⚠️ Model "${active.name}" is partially offloaded to CPU (${spilloverMb} MB / ${totalMb} MB in system RAM, ${Math.round(gpuRatio * 100)}% on GPU). Inference throughput will be significantly reduced.`;
        ExtensionLogger.log(`${this.LOGGER_TAG}: ${warningMessage}`);
      }

      return {
        isOffloaded,
        modelTag: active.name,
        totalSizeBytes: totalSize,
        vramSizeBytes: vramSize,
        cpuSpilloverBytes: spillover,
        gpuOffloadRatio: gpuRatio,
        warningMessage
      };
    } catch (err: any) {
      ExtensionLogger.log(`${this.LOGGER_TAG}: Failed to query /api/ps for offload status: ${err.message}`);
      return null;
    }
  }

  /**
   * Evaluates prefix cache stability between two consecutive prompt message arrays.
   * Prefix caching in Ollama / llama.cpp relies on strictly identical token sequences
   * from token 0 through the shared system and tool definitions.
   */
  public static verifyPrefixCacheStability(
    previousMessages: ChatMessage[],
    currentMessages: ChatMessage[]
  ): PrefixCacheVerificationResult {
    if (!previousMessages || previousMessages.length === 0 || !currentMessages || currentMessages.length === 0) {
      return { isStable: true, prefixLengthChars: 0 };
    }

    const prevSystem = previousMessages[0];
    const currSystem = currentMessages[0];

    // 1. Verify system prompt is byte-for-byte identical
    if (prevSystem.role !== currSystem.role) {
      return {
        isStable: false,
        prefixLengthChars: 0,
        divergenceIndex: 0,
        divergenceReason: `Role mismatch at message 0: expected "${prevSystem.role}", found "${currSystem.role}"`
      };
    }

    if (prevSystem.content !== currSystem.content) {
      // Find character divergence
      let diffIdx = 0;
      const minLen = Math.min(prevSystem.content.length, currSystem.content.length);
      while (diffIdx < minLen && prevSystem.content[diffIdx] === currSystem.content[diffIdx]) {
        diffIdx++;
      }
      return {
        isStable: false,
        prefixLengthChars: diffIdx,
        divergenceIndex: 0,
        divergenceReason: `System prompt mutated at character ${diffIdx}. Invariant prefix broken; prompt cache invalidated.`
      };
    }

    // 2. Measure common shared message prefix
    let sharedChars = prevSystem.content.length;
    const maxShared = Math.min(previousMessages.length, currentMessages.length);
    let commonTurnCount = 1;

    for (let i = 1; i < maxShared; i++) {
      const prev = previousMessages[i];
      const curr = currentMessages[i];

      if (prev.role === curr.role && prev.content === curr.content) {
        sharedChars += (curr.content || '').length;
        commonTurnCount++;
      } else {
        break;
      }
    }

    return {
      isStable: true,
      prefixLengthChars: sharedChars
    };
  }

  /**
   * Calculates safe context window size (numCtx) recommendation based on GPU memory.
   */
  public static recommendContextSize(modelSizeBytes: number, totalVramBytes: number = 8 * 1024 * 1024 * 1024): number {
    const freeVramGb = Math.max(0, (totalVramBytes - modelSizeBytes) / (1024 * 1024 * 1024));

    if (freeVramGb >= 6.0) return 32768;
    if (freeVramGb >= 4.0) return 16384;
    if (freeVramGb >= 2.5) return 8192;
    if (freeVramGb >= 1.5) return 4096;
    return 2048;
  }
}
