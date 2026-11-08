import { ExtensionLogger } from './extensionLogger';

/**
 * Deliverable 12.5: Local Inference Performance & Overhead Profiling
 * Profiles extension-host internal processing overhead versus Ollama generation duration.
 * Validates that extension internal processing overhead remains < 5% of total turn duration.
 * Surfaces performance health alerts when generation throughput drops below 50% of baseline.
 */

export interface TurnLatencyProfile {
  turnId: string;
  modelTag: string;
  totalTurnDurationMs: number;
  ollamaInferenceDurationMs: number;
  extensionOverheadMs: number;
  overheadPercentage: number; // e.g. 2.5%
  isOverheadAcceptable: boolean; // true if <= 5.0%
  evalTokensCount: number;
  promptTokensCount: number;
  tokensPerSecond: number;
  baselineTps?: number;
  isThrottled?: boolean; // true if TPS < 0.5 * baselineTps
  warningMessage?: string;
}

export class InferenceProfiler {
  public static readonly MAX_ACCEPTABLE_OVERHEAD_PERCENT = 5.0; // 5% max overhead
  private static readonly LOGGER_TAG = 'InferenceProfiler';

  /**
   * Computes latency breakdown and evaluates extension-host overhead.
   */
  public static profileTurn(params: {
    turnId: string;
    modelTag: string;
    totalTurnDurationMs: number;
    ollamaInferenceDurationMs: number;
    evalTokensCount: number;
    promptTokensCount: number;
    baselineTps?: number;
  }): TurnLatencyProfile {
    const total = Math.max(1, params.totalTurnDurationMs);
    const inference = Math.min(total, Math.max(0, params.ollamaInferenceDurationMs));
    const overheadMs = Math.max(0, total - inference);
    const overheadPct = Math.round((overheadMs / total) * 1000) / 10; // e.g. 3.2%
    const isAcceptable = overheadPct <= this.MAX_ACCEPTABLE_OVERHEAD_PERCENT;

    const tps = inference > 0 ? Math.round((params.evalTokensCount / (inference / 1000)) * 10) / 10 : 0;

    let isThrottled = false;
    let warningMessage: string | undefined;

    if (params.baselineTps && params.baselineTps > 0 && tps > 0) {
      if (tps < 0.5 * params.baselineTps) {
        isThrottled = true;
        warningMessage = `⚠️ Generation throughput for "${params.modelTag}" dropped to ${tps} tok/s (< 50% of ${params.baselineTps} tok/s baseline). Suspected GPU throttling, thermal limits, or external process contention.`;
        ExtensionLogger.log(`${this.LOGGER_TAG}: ${warningMessage}`);
      }
    }

    if (!isAcceptable) {
      ExtensionLogger.log(
        `${this.LOGGER_TAG}: High extension overhead detected on turn ${params.turnId} (${overheadPct}% > ${this.MAX_ACCEPTABLE_OVERHEAD_PERCENT}%). Overhead: ${overheadMs}ms, Total: ${total}ms`
      );
    }

    return {
      turnId: params.turnId,
      modelTag: params.modelTag,
      totalTurnDurationMs: total,
      ollamaInferenceDurationMs: inference,
      extensionOverheadMs: overheadMs,
      overheadPercentage: overheadPct,
      isOverheadAcceptable: isAcceptable,
      evalTokensCount: params.evalTokensCount,
      promptTokensCount: params.promptTokensCount,
      tokensPerSecond: tps,
      baselineTps: params.baselineTps,
      isThrottled,
      warningMessage
    };
  }

  /**
   * Formats an accessible summary of turn latency performance.
   */
  public static formatProfileSummary(profile: TurnLatencyProfile): string {
    return (
      `Turn Performance: Total ${profile.totalTurnDurationMs}ms | ` +
      `Inference: ${profile.ollamaInferenceDurationMs}ms (${profile.tokensPerSecond} tok/s) | ` +
      `Extension Overhead: ${profile.extensionOverheadMs}ms (${profile.overheadPercentage}%)`
    );
  }
}
