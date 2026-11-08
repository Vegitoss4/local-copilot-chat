import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { MeasurementEnvironment, HardwareFingerprint } from './measurementEnvironment';

/**
 * Deliverable 12.2: Quantization Evaluation & Pareto Frontier Analyzer
 * Discovers local quant variants via Ollama /api/tags, evaluates quality vs VRAM vs speed,
 * and identifies the Pareto Frontier under 8 GB VRAM hardware constraints.
 * Strictly read-only against Ollama: never pulls or downloads models automatically.
 */

export interface ModelQuantCandidate {
  modelTag: string;
  baseModel: string;
  quantization: string; // e.g. "Q4_K_M", "Q5_K_M", "Q8_0", "FP16"
  sizeBytes: number;
  sizeGb: number;
  vramBytes?: number;
  vramGb?: number;
  measuredTps?: number;
  qualityScore?: number; // 0 - 100
  isParetoOptimal?: boolean;
}

export interface ParetoFrontierResult {
  fingerprint: HardwareFingerprint;
  evaluatedCandidates: ModelQuantCandidate[];
  paretoFrontier: ModelQuantCandidate[];
  recommendedModel: ModelQuantCandidate | null;
  vramBudgetGb: number;
}

export class QuantizationEvaluator {
  public static readonly DEFAULT_VRAM_BUDGET_GB = 8.0;

  /**
   * Extracts the quantization tag suffix from a model tag name (e.g. "qwen2.5-coder:7b-instruct-q4_K_M" -> "Q4_K_M").
   */
  public static parseQuantization(modelTag: string): string {
    const lower = modelTag.toLowerCase();
    const match = lower.match(/(q[2-8]_[k0-9_a-z]+|fp16|fp32|bf16)/i);
    if (match) {
      return match[1].toUpperCase();
    }
    // Default heuristic for standard unannotated 7B/8B Ollama tags (typically Q4_K_M)
    return 'Q4_K_M (Default)';
  }

  /**
   * Discovers locally installed models and maps them into quant candidates.
   * Strictly reads from /api/tags without issuing any model download or pull requests.
   */
  public static async discoverLocalQuants(
    ollamaService?: OllamaService
  ): Promise<ModelQuantCandidate[]> {
    const service = ollamaService || new OllamaService();
    const modelNames = await service.getAvailableModels();

    return modelNames.map((name: string) => {
      const quant = this.parseQuantization(name);
      const baseName = name.split(':')[0];
      // Heuristic size estimation for common local models when exact bytes not in tags list
      const isLarge = name.includes('14b') || name.includes('32b');
      const isMedium = name.includes('7b') || name.includes('8b') || name.includes('9b');
      const estGb = isLarge ? 9.2 : (isMedium ? 4.8 : 2.5);
      const estBytes = estGb * 1024 * 1024 * 1024;

      return {
        modelTag: name,
        baseModel: baseName,
        quantization: quant,
        sizeBytes: estBytes,
        sizeGb: estGb,
        vramBytes: estBytes,
        vramGb: estGb
      };
    });
  }

  /**
   * Computes the Pareto Frontier across a set of model candidates.
   * A candidate A dominates candidate B if:
   * 1. A has >= qualityScore than B, AND
   * 2. A has >= measuredTps than B, AND
   * 3. A has <= vramGb than B, AND
   * 4. A is strictly better in at least one of these dimensions.
   */
  public static async computeParetoFrontier(
    candidates: ModelQuantCandidate[],
    vramBudgetGb: number = this.DEFAULT_VRAM_BUDGET_GB,
    customFingerprint?: HardwareFingerprint
  ): Promise<ParetoFrontierResult> {
    const fingerprint = customFingerprint || await MeasurementEnvironment.captureHardwareFingerprint();

    // Filter to candidates within VRAM budget (preventing CPU spillover)
    const withinBudget = candidates.filter(c => (c.vramGb ?? c.sizeGb) <= vramBudgetGb);

    const pareto: ModelQuantCandidate[] = [];

    for (let i = 0; i < withinBudget.length; i++) {
      const current = withinBudget[i];
      let isDominated = false;

      for (let j = 0; j < withinBudget.length; j++) {
        if (i === j) continue;
        const other = withinBudget[j];

        const otherScore = other.qualityScore ?? 0;
        const currScore = current.qualityScore ?? 0;
        const otherTps = other.measuredTps ?? 0;
        const currTps = current.measuredTps ?? 0;
        const otherVram = other.vramGb ?? other.sizeGb;
        const currVram = current.vramGb ?? current.sizeGb;

        const notWorse = otherScore >= currScore && otherTps >= currTps && otherVram <= currVram;
        const strictlyBetter = otherScore > currScore || otherTps > currTps || otherVram < currVram;

        if (notWorse && strictlyBetter) {
          isDominated = true;
          break;
        }
      }

      current.isParetoOptimal = !isDominated;
      if (!isDominated) {
        pareto.push(current);
      }
    }

    // Sort Pareto frontier: highest quality first, then highest TPS
    pareto.sort((a, b) => {
      const scoreDiff = (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.measuredTps ?? 0) - (a.measuredTps ?? 0);
    });

    const recommended = pareto.length > 0 ? pareto[0] : (withinBudget[0] || null);

    return {
      fingerprint,
      evaluatedCandidates: candidates,
      paretoFrontier: pareto,
      recommendedModel: recommended,
      vramBudgetGb
    };
  }

  /**
   * Formats a clean Markdown Pareto analysis table.
   */
  public static formatParetoTable(result: ParetoFrontierResult): string {
    let md = `### 📊 Model Quantization & Pareto Frontier Analysis (VRAM Budget: ${result.vramBudgetGb} GB)\n\n`;
    md += `| Model Tag | Quantization | Size (GB) | Est. VRAM (GB) | Throughput (tok/s) | Quality Score | Pareto Optimal? |\n`;
    md += `|---|---|---|---|---|---|---|\n`;

    for (const c of result.evaluatedCandidates) {
      const vram = c.vramGb ?? c.sizeGb;
      const tps = c.measuredTps ? `${c.measuredTps.toFixed(1)} tps` : 'N/A';
      const score = c.qualityScore !== undefined ? `${c.qualityScore.toFixed(1)}%` : 'N/A';
      const optimal = c.isParetoOptimal ? '⭐ **YES**' : 'No (Dominated)';
      md += `| \`${c.modelTag}\` | ${c.quantization} | ${c.sizeGb} GB | ${vram} GB | ${tps} | ${score} | ${optimal} |\n`;
    }

    if (result.recommendedModel) {
      md += `\n**Recommended Configuration**: \`${result.recommendedModel.modelTag}\` (${result.recommendedModel.quantization}) — optimal quality/speed trade-off under ${result.vramBudgetGb} GB VRAM.\n`;
    }

    return md;
  }
}
