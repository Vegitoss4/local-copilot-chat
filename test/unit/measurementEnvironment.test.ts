import * as assert from 'assert';
import {
  MeasurementEnvironment,
  HardwareFingerprint,
  StatisticalSummary,
  IdleGpuCheckResult
} from '../../src/services/measurementEnvironment';

describe('Deliverable 12.0: Hardware & Measurement Environment Suite', () => {
  describe('Statistical Analysis Controls', () => {
    it('should compute exact statistical summary for known distribution', () => {
      const data = [10, 20, 30, 40, 50];
      const stats = MeasurementEnvironment.calculateStatistics(data);

      assert.strictEqual(stats.runs, 5);
      assert.strictEqual(stats.mean, 30);
      assert.strictEqual(stats.min, 10);
      assert.strictEqual(stats.max, 50);
      assert.strictEqual(stats.p50, 30);
      // Sample standard deviation of [10,20,30,40,50]: sqrt(250) = 15.81
      assert.strictEqual(stats.stdDev, 15.81);
      assert.ok(stats.p95 >= 45 && stats.p95 <= 50);
    });

    it('should handle empty and single-element arrays gracefully', () => {
      const emptyStats = MeasurementEnvironment.calculateStatistics([]);
      assert.strictEqual(emptyStats.runs, 0);
      assert.strictEqual(emptyStats.mean, 0);
      assert.strictEqual(emptyStats.stdDev, 0);

      const singleStats = MeasurementEnvironment.calculateStatistics([42]);
      assert.strictEqual(singleStats.runs, 1);
      assert.strictEqual(singleStats.mean, 42);
      assert.strictEqual(singleStats.stdDev, 0);
      assert.strictEqual(singleStats.min, 42);
      assert.strictEqual(singleStats.max, 42);
      assert.strictEqual(singleStats.p50, 42);
      assert.strictEqual(singleStats.p95, 42);
    });

    it('should correctly classify cold and warm benchmark iterations', () => {
      const run0 = MeasurementEnvironment.classifyRunWarmth(0);
      assert.strictEqual(run0.isCold, true);
      assert.strictEqual(run0.isWarm, false);

      const run1 = MeasurementEnvironment.classifyRunWarmth(1);
      assert.strictEqual(run1.isCold, false);
      assert.strictEqual(run1.isWarm, true);

      const run2 = MeasurementEnvironment.classifyRunWarmth(2);
      assert.strictEqual(run2.isCold, false);
      assert.strictEqual(run2.isWarm, true);
    });

    it('should maintain deterministic fixed seed for reproducibility', () => {
      MeasurementEnvironment.setFixedSeed(12345);
      assert.strictEqual(MeasurementEnvironment.getFixedSeed(), 12345);
      MeasurementEnvironment.setFixedSeed(42);
      assert.strictEqual(MeasurementEnvironment.getFixedSeed(), 42);
    });
  });

  describe('Hardware Fingerprinting', () => {
    it('should capture hardware fingerprint when nvidia-smi succeeds', async () => {
      const mockExec = async (cmd: string, args: string[]) => {
        if (cmd === 'nvidia-smi') {
          return {
            stdout: 'NVIDIA GeForce RTX 3070 Ti, 560.94, 8192, 6144\n',
            stderr: '',
            exitCode: 0
          };
        }
        return { stdout: '', stderr: 'Command not found', exitCode: 1 };
      };

      const fp: HardwareFingerprint = await MeasurementEnvironment.captureHardwareFingerprint({
        execFn: mockExec,
        vscodeVersion: '1.96.0'
      });

      assert.strictEqual(fp.gpuName, 'NVIDIA GeForce RTX 3070 Ti');
      assert.strictEqual(fp.driverVersion, '560.94');
      assert.strictEqual(fp.totalVramBytes, 8192 * 1024 * 1024);
      assert.strictEqual(fp.freeVramBytes, 6144 * 1024 * 1024);
      assert.ok(fp.cpuModel.length > 0);
      assert.ok(fp.logicalCores >= 1);
      assert.ok(fp.totalRamBytes > 0);
      assert.strictEqual(fp.vscodeVersion, '1.96.0');
      assert.ok(fp.timestamp.includes('T'));
    });

    it('should fallback gracefully when nvidia-smi is unavailable (e.g. CPU or non-Nvidia)', async () => {
      const mockExec = async (cmd: string, args: string[]) => {
        return { stdout: '', stderr: 'nvidia-smi: command not found', exitCode: 127 };
      };

      const fp = await MeasurementEnvironment.captureHardwareFingerprint({
        execFn: mockExec
      });

      assert.strictEqual(fp.gpuName, 'N/A (CPU fallback)');
      assert.strictEqual(fp.driverVersion, 'unknown');
      assert.strictEqual(fp.totalVramBytes, 0);
      assert.strictEqual(fp.freeVramBytes, 0);
      assert.ok(fp.cpuModel.length > 0);
    });
  });

  describe('Idle GPU Verification Check', () => {
    it('should report idle when free VRAM exceeds threshold', async () => {
      const mockExec = async () => ({
        stdout: '6144, 8192\n',
        stderr: '',
        exitCode: 0
      });

      const res: IdleGpuCheckResult = await MeasurementEnvironment.checkIdleGpu({
        thresholdFreeVramBytes: 4 * 1024 * 1024 * 1024, // 4 GB threshold
        execFn: mockExec
      });

      assert.strictEqual(res.isIdle, true);
      assert.strictEqual(res.freeVramBytes, 6144 * 1024 * 1024);
      assert.strictEqual(res.totalVramBytes, 8192 * 1024 * 1024);
    });

    it('should report not idle when free VRAM is below threshold', async () => {
      const mockExec = async () => ({
        stdout: '2048, 8192\n',
        stderr: '',
        exitCode: 0
      });

      const res = await MeasurementEnvironment.checkIdleGpu({
        thresholdFreeVramBytes: 4 * 1024 * 1024 * 1024,
        execFn: mockExec
      });

      assert.strictEqual(res.isIdle, false);
      assert.strictEqual(res.freeVramBytes, 2048 * 1024 * 1024);
      assert.ok(res.reason?.includes('Insufficient free GPU VRAM'));
    });

    it('should pass with warning reason when nvidia-smi is not found', async () => {
      const mockExec = async () => ({
        stdout: '',
        stderr: 'not found',
        exitCode: 1
      });

      const res = await MeasurementEnvironment.checkIdleGpu({
        execFn: mockExec
      });

      assert.strictEqual(res.isIdle, true);
      assert.ok(res.reason?.includes('nvidia-smi not available'));
    });
  });
});
