const cp = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const gpuRaw = cp.execSync('nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free --format=csv,noheader,nounits', { encoding: 'utf8' }).trim();
const [gpuName, driverVersion, totalVramMB, freeVramMB] = gpuRaw.split(',').map(s => s.trim());

let ollamaVersion = 'unknown';
const ollamaExe = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Sagar\\AppData\\Local', 'Programs', 'Ollama', 'ollama.exe');
if (fs.existsSync(ollamaExe)) {
  try {
    ollamaVersion = cp.execFileSync(ollamaExe, ['--version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    ollamaVersion = e.message;
  }
} else {
  try {
    ollamaVersion = cp.execSync('ollama --version', { encoding: 'utf8' }).trim();
  } catch (e) {
    ollamaVersion = e.message;
  }
}

const fingerprint = {
  rawCommandOutputs: {
    nvidiaSmi: gpuRaw,
    ollamaVersion: ollamaVersion,
  },
  gpu: {
    name: gpuName,
    driverVersion: driverVersion,
    totalVramMB: Number(totalVramMB),
    freeVramMB: Number(freeVramMB)
  },
  cpu: {
    model: os.cpus()[0].model.trim(),
    cores: os.cpus().length,
    arch: os.arch()
  },
  ram: {
    totalBytes: os.totalmem(),
    totalGB: (os.totalmem() / (1024 ** 3)).toFixed(2),
    freeBytes: os.freemem(),
    freeGB: (os.freemem() / (1024 ** 3)).toFixed(2)
  },
  os: {
    platform: os.platform(),
    release: os.release(),
    type: os.type(),
    version: os.version()
  },
  ollama: {
    versionString: ollamaVersion
  },
  node: {
    version: process.version
  },
  capturedAt: new Date().toISOString()
};

const outPath = path.join(__dirname, 'results', 'hardware_fingerprint.json');
fs.writeFileSync(outPath, JSON.stringify(fingerprint, null, 2));
console.log('Saved hardware fingerprint to:', outPath);
console.log(JSON.stringify(fingerprint, null, 2));
