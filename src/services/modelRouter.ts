import * as path from 'path';
import * as vscode from 'vscode';
import { AtomicFileWriter } from './atomicFileWriter';
import { HardwareFingerprint } from './measurementEnvironment';
import { ModelCapabilityResult, ModelProbeResult } from './ollamaService';

export interface RouteDecision {
  model: string;
  reason: string;
  intent: 'reasoning' | 'coding' | 'agent' | 'default';
  isSwapRecommended?: boolean;
  swapCostMs?: number;
  hasTools?: boolean;
  isCapabilityUnknown?: boolean;
  actionableMessage?: string;
  toolCapableAlternatives?: string[];
}

export interface ModelProfile {
  modelTag: string;
  measuredTps: number;
  vramBytes: number;
  effectiveContextTokens: number;
  toolCallReliability: number; // 0.0 - 1.0
  categoryStrengths: Record<string, number>; // e.g. { code_repair: 85, feature_gen: 70, refactor: 80 }
  swapCostMs: number; // e.g. 4500ms
  fingerprint?: HardwareFingerprint;
  lastCalibrated?: string;
}

export interface RouteProfileParams {
  prompt: string;
  mode?: 'chat' | 'agent' | 'plan';
  currentResidentModel?: string;
  availableModels?: string[];
  profiles?: Map<string, ModelProfile>;
  isRouterEnabled?: boolean;
  swapThresholdPercent?: number; // default 15 (%)
}

/**
 * Heuristic weights used by ModelRouter for candidate ranking and tie-breaking.
 * NOTE: These are expert heuristics for relative preference, NOT empirically measured transfer functions.
 * - PROFILE_TOOL_RELIABILITY_WEIGHT (100): Scales toolCallReliability (0.0 to 1.0) to 0-100 pts in agent mode.
 * - NATIVE_TOOL_PROBE_BONUS (50): Preference bonus for models proven by behavioral probe to emit native tool_calls.
 * - CONTENT_TOOL_PROBE_BONUS (20): Preference bonus for models emitting valid tool JSON in content fallback.
 * - PROBE_LATENCY_MAX_BONUS (30): Latency responsiveness bonus scaled down by probe roundtrip time.
 * - TOOL_CAPABILITY_BONUS (40): Declarative bonus when /api/show advertises 'tools' capability for agent/coding intent.
 * - INSERT_CAPABILITY_BONUS (10): Declarative bonus when /api/show advertises 'insert' (FIM completion) capability.
 * - THINKING_CAPABILITY_BONUS (40): Declarative bonus when /api/show advertises 'thinking' capability for reasoning intent.
 * - MEASURED_TPS_TIEBREAKER_WEIGHT (0.05): Small scaling factor for measured tokens/sec to break ties without overpowering reliability.
 */
export const ROUTER_HEURISTIC_WEIGHTS = {
  PROFILE_TOOL_RELIABILITY_WEIGHT: 100,
  NATIVE_TOOL_PROBE_BONUS: 50,
  CONTENT_TOOL_PROBE_BONUS: 20,
  PROBE_LATENCY_MAX_BONUS: 30,
  TOOL_CAPABILITY_BONUS: 40,
  INSERT_CAPABILITY_BONUS: 10,
  THINKING_CAPABILITY_BONUS: 40,
  MEASURED_TPS_TIEBREAKER_WEIGHT: 0.05,
};

export class ModelRouter {
  public static readonly DEFAULT_SWAP_THRESHOLD = 15; // Requires >= 15% quality improvement to justify model swap

  private static readonly REASONING_KEYWORDS = [
    'why', 'explain', 'design', 'architect', 'architecture', 'plan', 'debug',
    'diagnose', 'error', 'trace', 'analyze', 'analysis', 'structure', 'how does', 'compare',
    'difference', 'review', 'audit', 'evaluate', 'investigate', 'root cause'
  ];

  private static readonly CODING_KEYWORDS = [
    'write', 'generate', 'create', 'fix', 'refactor', 'add', 'component',
    'endpoint', 'implement', 'code', 'function', 'class', 'method', 'patch',
    'controller', 'service', 'model', 'html', 'css', 'typescript', 'csharp',
    'dotnet', 'angular', 'unit test', 'test', 'syntax', 'bug', 'error'
  ];

  /**
   * Fast heuristic intent classifier that maps user prompt to the optimal local model
   * without incurring LLM inference latency or VRAM overhead.
   */
  public static route(
    prompt: string,
    mode: 'chat' | 'agent' = 'chat',
    availableModels: string[] = []
  ): string {
    const decision = this.classifyIntent(prompt, mode, availableModels);
    return decision.model;
  }

  public static classifyIntent(
    prompt: string,
    mode: 'chat' | 'agent' | 'plan' = 'chat',
    availableModels: string[] = [],
    capabilitiesMap?: Map<string, ModelCapabilityResult>,
    probesMap?: Map<string, ModelProbeResult>,
    profilesMap?: Map<string, ModelProfile>,
    pinnedModel?: string
  ): RouteDecision {
    const lower = prompt.toLowerCase();

    // Determine base prompt intent based on semantic keywords
    const hasReasoning = this.REASONING_KEYWORDS.some(kw => {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      return regex.test(lower);
    });
    const hasCoding = this.CODING_KEYWORDS.some(kw => {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      return regex.test(lower);
    });
    const detectedIntent: 'reasoning' | 'coding' | 'agent' | 'default' =
      mode === 'agent' ? 'agent' : hasReasoning ? 'reasoning' : hasCoding ? 'coding' : 'default';

    // Embedding-only exclusion: models declaring capabilities ['embedding'] without ['completion']
    // must NEVER be selected as chat, agent, or plan candidates.
    const isGenerativeCandidate = (m: string): boolean => {
      const cap = capabilitiesMap?.get(m);
      if (!cap || !cap.capabilities || cap.capabilities.length === 0) return true;
      if (cap.capabilities.includes('embedding') && !cap.capabilities.includes('completion')) {
        return false;
      }
      return true;
    };

    const eligibleModels = availableModels.filter(isGenerativeCandidate);

    // Helper: evaluate data score for candidate model strictly by empirical evidence
    const scoreCandidate = (m: string): { score: number; hasData: boolean; dataReasons: string[] } => {
      let score = 0;
      let hasData = false;
      const reasons: string[] = [];

      // 1. Measured ModelProfile data
      const prof = profilesMap?.get(m);
      if (prof) {
        hasData = true;
        // In agent mode, toolCallReliability is paramount
        if (detectedIntent === 'agent' && typeof prof.toolCallReliability === 'number') {
          score += prof.toolCallReliability * ROUTER_HEURISTIC_WEIGHTS.PROFILE_TOOL_RELIABILITY_WEIGHT;
          reasons.push(`tool reliability ${Math.round(prof.toolCallReliability * 100)}%`);
        }
        // Intent-specific category score (e.g. reasoning vs code_repair)
        const intentKey = detectedIntent === 'reasoning' ? 'reasoning' : 'code_repair';
        if (prof.categoryStrengths && typeof prof.categoryStrengths[intentKey] === 'number') {
          score += prof.categoryStrengths[intentKey];
          reasons.push(`${intentKey} strength ${prof.categoryStrengths[intentKey]}`);
        }
        // Measured TPS as bounded tiebreaker
        if (prof.measuredTps && prof.measuredTps > 0) {
          score += prof.measuredTps * ROUTER_HEURISTIC_WEIGHTS.MEASURED_TPS_TIEBREAKER_WEIGHT;
          reasons.push(`${prof.measuredTps.toFixed(1)} tps`);
        }
      }

      // 2. Behavioral tool probe result
      const probe = probesMap?.get(m);
      if (probe && probe.supported) {
        hasData = true;
        if (probe.emittedNativeCalls) {
          score += ROUTER_HEURISTIC_WEIGHTS.NATIVE_TOOL_PROBE_BONUS; // Native tool execution preferred over content fallback
          reasons.push('native tools');
        } else if (probe.emittedContentCalls) {
          score += ROUTER_HEURISTIC_WEIGHTS.CONTENT_TOOL_PROBE_BONUS;
          reasons.push('content fallback tools');
        }
        if (probe.latencyMs && probe.latencyMs > 0) {
          score += Math.max(0, ROUTER_HEURISTIC_WEIGHTS.PROBE_LATENCY_MAX_BONUS - probe.latencyMs / 100);
        }
      }

      // 3. /api/show capability declarations
      const cap = capabilitiesMap?.get(m);
      if (cap && cap.capabilities) {
        if (detectedIntent === 'agent') {
          if (cap.capabilities.includes('tools')) {
            score += ROUTER_HEURISTIC_WEIGHTS.TOOL_CAPABILITY_BONUS;
            hasData = true;
          }
        } else if (detectedIntent === 'coding') {
          if (cap.capabilities.includes('tools')) {
            score += ROUTER_HEURISTIC_WEIGHTS.TOOL_CAPABILITY_BONUS;
            hasData = true;
          }
          if (cap.capabilities.includes('insert')) {
            score += ROUTER_HEURISTIC_WEIGHTS.INSERT_CAPABILITY_BONUS;
            hasData = true;
          }
        } else if (detectedIntent === 'reasoning') {
          if (cap.capabilities.includes('thinking')) {
            score += ROUTER_HEURISTIC_WEIGHTS.THINKING_CAPABILITY_BONUS;
            hasData = true;
            reasons.push('thinking capability');
          }
        }
      }

      return { score, hasData, dataReasons: reasons };
    };

    // Mode: Agent - Must select strictly models whose capabilities declare tools and pass probe
    if (mode === 'agent') {
      if (capabilitiesMap && capabilitiesMap.size > 0) {
        const toolModels: string[] = [];
        const unknownModels: string[] = [];
        for (const m of eligibleModels) {
          const cap = capabilitiesMap.get(m);
          const probe = probesMap?.get(m);
          const probePassed = probe === undefined || probe.supported;

          if (cap?.hasTools && probePassed) {
            toolModels.push(m);
          } else if (cap?.status === 'unknown') {
            unknownModels.push(m);
          }
        }

        if (toolModels.length > 0) {
          const scored = toolModels.map(m => ({ model: m, ...scoreCandidate(m) }));
          const anyHasData = scored.some(s => s.hasData);
          const allSameScore = scored.every(s => s.score === scored[0].score);

          // If there is no data to rank, keep the user's pinned model and say so
          if (!anyHasData || allSameScore) {
            const keepPinned = pinnedModel && toolModels.includes(pinnedModel);
            const selected = keepPinned ? pinnedModel : toolModels[0];
            const reason = keepPinned
              ? `Agent Mode active: No ranking data to differentiate models; preserving user-selected model "${pinnedModel}".`
              : `Agent Mode active: Routing to verified tool-capable model "${selected}".`;
            return {
              model: selected,
              reason,
              intent: 'agent',
              hasTools: true,
              toolCapableAlternatives: toolModels.filter(m => m !== selected)
            };
          }

          scored.sort((a, b) => b.score - a.score);
          const selected = scored[0].model;
          const details = scored[0].dataReasons.length > 0 ? ` (${scored[0].dataReasons.join(', ')})` : '';
          return {
            model: selected,
            reason: `Agent Mode active: Routing to data-ranked tool-capable model "${selected}"${details}.`,
            intent: 'agent',
            hasTools: true,
            toolCapableAlternatives: toolModels.filter(m => m !== selected)
          };
        }

        if (unknownModels.length === eligibleModels.length && eligibleModels.length > 0) {
          const selected = pinnedModel && eligibleModels.includes(pinnedModel) ? pinnedModel : eligibleModels[0];
          return {
            model: selected,
            reason: 'Capabilities unknown for all available models: cannot verify tool support before routing in Agent mode.',
            intent: 'agent',
            isCapabilityUnknown: true,
            hasTools: false
          };
        }

        return {
          model: '',
          reason: 'No installed models declare tool-calling capability and pass behavioral probe for Agent mode.',
          intent: 'agent',
          hasTools: false,
          actionableMessage: 'None of the installed models pass tool-calling validation.',
          toolCapableAlternatives: []
        };
      }

      const fallback = pinnedModel && eligibleModels.includes(pinnedModel) ? pinnedModel : (eligibleModels[0] || '');
      return {
        model: fallback,
        reason: 'Capabilities unknown: /api/show data was not supplied for Agent mode validation.',
        intent: 'agent',
        isCapabilityUnknown: true,
        hasTools: false
      };
    }

    if (mode === 'plan') {
      const fallback = pinnedModel && eligibleModels.includes(pinnedModel) ? pinnedModel : (eligibleModels[0] || '');
      return {
        model: fallback,
        reason: 'Plan Mode active: Routing to planner model',
        intent: 'agent'
      };
    }

    // Chat mode: rank available candidates strictly by data
    if (eligibleModels.length === 0) {
      const keepPinned = pinnedModel && isGenerativeCandidate(pinnedModel);
      const selected = keepPinned ? pinnedModel : '';
      return {
        model: selected,
        reason: selected
          ? `Keeping user-selected model "${selected}".`
          : 'No generative chat models available (installed models lack completion capability).',
        intent: detectedIntent
      };
    }

    const scored = eligibleModels.map(m => ({ model: m, ...scoreCandidate(m) }));
    const anyHasData = scored.some(s => s.hasData);
    const allSameScore = scored.every(s => s.score === scored[0].score);
    const intentLabel = detectedIntent === 'reasoning' ? 'Reasoning' : detectedIntent === 'coding' ? 'Code synthesis' : 'Default';

    if (!anyHasData || allSameScore) {
      const keepPinned = pinnedModel && eligibleModels.includes(pinnedModel);
      const selected = keepPinned ? pinnedModel : eligibleModels[0];
      const reason = keepPinned
        ? `${intentLabel} intent detected: Keeping user-selected model "${pinnedModel}" (no ranking data to differentiate).`
        : `${intentLabel} intent detected: Routing to available model "${selected}".`;
      return {
        model: selected,
        reason,
        intent: detectedIntent
      };
    }

    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0].model;
    const details = scored[0].dataReasons.length > 0 ? ` (${scored[0].dataReasons.join(', ')})` : '';
    return {
      model: selected,
      reason: `${intentLabel} intent detected: Routing to data-ranked model "${selected}"${details}.`,
      intent: detectedIntent
    };
  }

  /**
   * Actionable validation for user-pinned models in Agent mode.
   * If model lacks tools, returns actionable alternatives and fallback notice.
   */
  public static validatePinnedModel(
    pinnedModel: string,
    capability: ModelCapabilityResult,
    installedToolModels: string[] = [],
    probeResult?: ModelProbeResult
  ): { valid: boolean; actionableMessage?: string; fallbackNotice?: string } {
    if (capability.status === 'unknown') {
      return {
        valid: false,
        actionableMessage: `Capabilities for "${pinnedModel}" are unknown (/api/show returned no capability data).`
      };
    }
    const alts = installedToolModels.filter(m => m !== pinnedModel);
    const altStr = alts.length > 0
      ? ` Installed tool-capable models: ${alts.join(', ')}.`
      : ' No installed models declare tool capability in /api/tags.';

    if (!capability.hasTools) {
      return {
        valid: false,
        actionableMessage: `Pinned model "${pinnedModel}" lacks tool-calling capabilities required for Agent mode.${altStr}`,
        fallbackNotice: `Using structured-edit fallback protocol for model "${pinnedModel}" (native tool calling disabled).`
      };
    }
    if (probeResult && !probeResult.supported) {
      return {
        valid: false,
        actionableMessage: `Pinned model "${pinnedModel}" declared tool capability but failed the active behavioral tool probe.${altStr}`,
        fallbackNotice: `Using structured-edit fallback protocol for model "${pinnedModel}" (behavioral probe failed).`
      };
    }
    return { valid: true };
  }

  /**
   * Swap-cost aware routing evaluation using calibrated ModelProfiles.
   * If router is disabled (default), keeps current resident model to prevent unnecessary VRAM churn.
   */
  public static evaluateRouteWithProfiles(params: RouteProfileParams): RouteDecision {
    const isEnabled = params.isRouterEnabled ?? false;
    const resident = params.currentResidentModel;
    const available = params.availableModels || [];
    const threshold = params.swapThresholdPercent ?? this.DEFAULT_SWAP_THRESHOLD;

    // 1. If router is disabled and a resident model exists, stick to resident model
    if (!isEnabled && resident) {
      return {
        model: resident,
        reason: `ModelRouter is disabled: Preserving resident model "${resident}" to eliminate reload latency`,
        intent: 'default',
        isSwapRecommended: false,
        swapCostMs: 0
      };
    }

    // 2. Classify base intent with empirical data if available
    const baseDecision = this.classifyIntent(
      params.prompt,
      params.mode || 'chat',
      available,
      undefined,
      undefined,
      params.profiles,
      resident
    );

    // 3. If target is already resident or no resident exists, adopt base decision
    if (!resident || resident === baseDecision.model) {
      return {
        ...baseDecision,
        isSwapRecommended: false,
        swapCostMs: 0
      };
    }

    // 4. Compare profiles if available
    const residentProfile = params.profiles?.get(resident);
    const targetProfile = params.profiles?.get(baseDecision.model);

    if (residentProfile && targetProfile) {
      const intentKey = baseDecision.intent === 'reasoning' ? 'reasoning' : 'code_repair';
      const residentScore = residentProfile.categoryStrengths[intentKey] ?? 50;
      const targetScore = targetProfile.categoryStrengths[intentKey] ?? 50;
      const expectedDelta = targetScore - residentScore;

      // Only swap if expected capability gain meets or exceeds threshold
      if (expectedDelta < threshold) {
        return {
          model: resident,
          reason: `Swap cost (${targetProfile.swapCostMs}ms) not justified: delta (+${expectedDelta}%) is below threshold (+${threshold}%)`,
          intent: baseDecision.intent,
          isSwapRecommended: false,
          swapCostMs: 0
        };
      }

      return {
        model: baseDecision.model,
        reason: `Swap justified: delta (+${expectedDelta}%) exceeds threshold (+${threshold}%) despite ${targetProfile.swapCostMs}ms reload delay`,
        intent: baseDecision.intent,
        isSwapRecommended: true,
        swapCostMs: targetProfile.swapCostMs
      };
    }

    // Default to base decision
    return baseDecision;
  }

  /**
   * Persists a ModelProfile atomically to .vscode/local-copilot/model-profiles/<safeName>.json
   */
  public static async saveProfile(profile: ModelProfile, baseDir?: string): Promise<string> {
    const root = baseDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('Workspace root required to save model profile.');
    }

    const safeName = profile.modelTag.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const profilePath = path.join(root, '.vscode', 'local-copilot', 'model-profiles', `${safeName}.json`);

    await AtomicFileWriter.writeJson(vscode.Uri.file(profilePath), profile);
    return profilePath;
  }

  /**
   * Loads a ModelProfile from .vscode/local-copilot/model-profiles/<safeName>.json
   */
  public static async loadProfile(modelTag: string, baseDir?: string): Promise<ModelProfile | null> {
    const root = baseDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;

    const safeName = modelTag.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const profilePath = path.join(root, '.vscode', 'local-copilot', 'model-profiles', `${safeName}.json`);

    return await AtomicFileWriter.readJson<ModelProfile | null>(vscode.Uri.file(profilePath), null);
  }
}
