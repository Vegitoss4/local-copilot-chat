import * as os from 'os';
import * as child_process from 'child_process';
import * as http from 'http';

/**
 * Deliverable 12.0: Hardware & Measurement Environment
 * Provides immutable hardware fingerprinting, statistical variance controls,
 * cold/warm run separation, and idle GPU verification for reproducible benchmarks.
 */

export interface HardwareFingerprint {
  gpuName: string;
  driverVersion: string;
  totalVramBytes: number;
  freeVramBytes: number;
  cpuModel: string;
  logicalCores: number;
  cpuArch: string;
  totalRamBytes: number;
  freeRamBytes: number;
  osPlatform: string;
  osRelease: string;
  ollamaVersion: string;
  nodeVersion: string;
  vscodeVersion: string;
  timestamp: string;
}

export interface StatisticalSummary {
  runs: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

export interface IdleGpuCheckResult {
  isIdle: boolean;
  freeVramBytes: number;
  totalVramBytes: number;
  reason?: string;
}

export interface MeasurementEnvironmentOptions {
  execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  ollamaEndpoint?: string;
  vscodeVersion?: string;
}

export class MeasurementEnvironment {
  private static _fixedSeed: number = 42;

  /**
   * Sets or retrieves the benchmark deterministic random seed.
   */
  public static getFixedSeed(): number {
    return this._fixedSeed;
  }

  public static setFixedSeed(seed: number): void {
    this._fixedSeed = seed;
  }

  /**
   * Computes comprehensive descriptive statistics for an array of numeric measurements.
   */
  public static calculateStatistics(values: number[]): StatisticalSummary {
    if (!values || values.length === 0) {
      return {
        runs: 0,
        mean: 0,
        stdDev: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0
      };
    }

    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const mean = sum / n;

    // Sample variance / standard deviation
    let variance = 0;
    if (n > 1) {
      const sqDiffSum = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
      variance = sqDiffSum / (n - 1);
    }
    const stdDev = Math.sqrt(variance);

    // Percentile helper using linear interpolation
    const getPercentile = (p: number): number => {
      if (n === 1) return sorted[0];
      const index = p * (n - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;
      return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    };

    return {
      runs: n,
      mean: Math.round(mean * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      min: Math.round(sorted[0] * 100) / 100,
      max: Math.round(sorted[n - 1] * 100) / 100,
      p50: Math.round(getPercentile(0.50) * 100) / 100,
      p95: Math.round(getPercentile(0.95) * 100) / 100
    };
  }

  /**
   * Identifies whether a benchmark iteration is cold (first iteration) or warm (subsequent iterations).
   */
  public static classifyRunWarmth(runIndex: number): { isWarm: boolean; isCold: boolean } {
    return {
      isCold: runIndex === 0,
      isWarm: runIndex > 0
    };
  }

  /**
   * Queries Ollama /api/version or falls back to 'unknown'.
   */
  private static async _queryOllamaVersion(endpoint: string = 'http://127.0.0.1:11434'): Promise<string> {
    return new Promise<string>((resolve) => {
      try {
        const url = new URL('/api/version', endpoint);
        const req = http.get(url, { timeout: 1500 }, (res) => {
          if (res.statusCode !== 200) {
            resolve('unknown');
            return;
          }
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.version || 'unknown');
            } catch {
              resolve('unknown');
            }
          });
        });
        req.on('error', () => resolve('unknown'));
        req.on('timeout', () => {
          req.destroy();
          resolve('unknown');
        });
      } catch {
        resolve('unknown');
      }
    });
  }

  /**
   * Default command execution using child_process.execFile.
   */
  private static async _defaultExec(
    cmd: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      child_process.execFile(cmd, args, { timeout: 3000 }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0)
        });
      });
    });
  }

  /**
   * Captures an immutable hardware fingerprint containing GPU, CPU, RAM, OS, and runtime versions.
   */
  public static async captureHardwareFingerprint(
    options?: MeasurementEnvironmentOptions
  ): Promise<HardwareFingerprint> {
    const exec = options?.execFn ?? this._defaultExec;
    const ollamaEndpoint = options?.ollamaEndpoint ?? 'http://127.0.0.1:11434';
    const vscodeVersion = options?.vscodeVersion ?? 'unknown';

    // 1. CPU & System info
    const cpus = os.cpus();
    const cpuModel = cpus && cpus.length > 0 ? cpus[0].model.trim() : 'Unknown CPU';
    const logicalCores = cpus ? cpus.length : 1;
    const cpuArch = os.arch();
    const totalRamBytes = os.totalmem();
    const freeRamBytes = os.freemem();
    const osPlatform = os.platform();
    const osRelease = os.release();

    // 2. GPU via nvidia-smi
    let gpuName = 'N/A (CPU fallback)';
    let driverVersion = 'unknown';
    let totalVramBytes = 0;
    let freeVramBytes = 0;

    try {
      const res = await exec('nvidia-smi', [
        '--query-gpu=name,driver_version,memory.total,memory.free',
        '--format=csv,noheader,nounits'
      ]);
      if (res.exitCode === 0 && res.stdout.trim().length > 0) {
        // e.g. "NVIDIA GeForce RTX 3070 Ti, 560.94, 8192, 6144"
        const parts = res.stdout.trim().split('\n')[0].split(',').map(s => s.trim());
        if (parts.length >= 4) {
          gpuName = parts[0];
          driverVersion = parts[1];
          const totalMB = parseFloat(parts[2]);
          const freeMB = parseFloat(parts[3]);
          if (!isNaN(totalMB)) totalVramBytes = Math.round(totalMB * 1024 * 1024);
          if (!isNaN(freeMB)) freeVramBytes = Math.round(freeMB * 1024 * 1024);
        }
      }
    } catch {
      // Non-Nvidia or nvidia-smi not available in environment
    }

    // 3. Ollama version
    const ollamaVersion = await this._queryOllamaVersion(ollamaEndpoint);

    return {
      gpuName,
      driverVersion,
      totalVramBytes,
      freeVramBytes,
      cpuModel,
      logicalCores,
      cpuArch,
      totalRamBytes,
      freeRamBytes,
      osPlatform,
      osRelease,
      ollamaVersion,
      nodeVersion: process.version,
      vscodeVersion,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Verifies that the GPU is idle and has sufficient free VRAM for benchmarking.
   * Default threshold: 3.5 GB free VRAM (allows running 7B models in 8 GB total).
   */
  public static async checkIdleGpu(
    options?: {
      thresholdFreeVramBytes?: number;
      execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    }
  ): Promise<IdleGpuCheckResult> {
    const threshold = options?.thresholdFreeVramBytes ?? (3.5 * 1024 * 1024 * 1024);
    const exec = options?.execFn ?? this._defaultExec;

    try {
      const res = await exec('nvidia-smi', [
        '--query-gpu=memory.free,memory.total',
        '--format=csv,noheader,nounits'
      ]);

      if (res.exitCode !== 0 || !res.stdout.trim()) {
        return {
          isIdle: true,
          freeVramBytes: 0,
          totalVramBytes: 0,
          reason: 'nvidia-smi not available; proceeding without GPU VRAM lock check'
        };
      }

      const parts = res.stdout.trim().split('\n')[0].split(',').map(s => s.trim());
      const freeMB = parseFloat(parts[0]);
      const totalMB = parseFloat(parts[1]);
      const freeBytes = (!isNaN(freeMB) ? freeMB : 0) * 1024 * 1024;
      const totalBytes = (!isNaN(totalMB) ? totalMB : 0) * 1024 * 1024;

      if (freeBytes < threshold) {
        const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
        const reqGB = (threshold / (1024 * 1024 * 1024)).toFixed(2);
        return {
          isIdle: false,
          freeVramBytes: freeBytes,
          totalVramBytes: totalBytes,
          reason: `Insufficient free GPU VRAM: ${freeGB} GB available, requires ${reqGB} GB. Close competing GPU processes.`
        };
      }

      return {
        isIdle: true,
        freeVramBytes: freeBytes,
        totalVramBytes: totalBytes
      };
    } catch {
      return {
        isIdle: true,
        freeVramBytes: 0,
        totalVramBytes: 0,
        reason: 'GPU query failed; proceeding in fallback mode'
      };
    }
  }
}
