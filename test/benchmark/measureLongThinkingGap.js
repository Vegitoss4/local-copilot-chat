const fs = require('fs');
const path = require('path');
const { nativeFetch } = require('../../out-test/test/setup.js');
global.fetch = nativeFetch;

async function measureLongThinking() {
  console.log('=== MEASURING LONG THINKING MAX CHUNK GAP ON LIVE qwen3.5:9b ===\n');

  const prompt = 'Solve and explain in deep mathematical detail: Prove whether the sum of the reciprocals of prime numbers diverges, showing the Euler product connection, Taylor expansion approximation, and error bounds.';
  const endpoint = 'http://127.0.0.1:11434';

  const payload = {
    model: 'qwen3.5:9b',
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    options: {
      num_ctx: 16384,
      temperature: 0.2
    }
  };

  const startTime = Date.now();
  const res = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let chunkCount = 0;
  let lastChunkTime = Date.now();
  let maxChunkGapMs = 0;
  const chunkGaps = [];

  let fullContent = '';
  let thinkStartTime = null;
  let thinkEndTime = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const now = Date.now();
    const gap = now - lastChunkTime;
    if (chunkCount > 0) {
      chunkGaps.push(gap);
      if (gap > maxChunkGapMs) {
        maxChunkGapMs = gap;
      }
    }
    lastChunkTime = now;
    chunkCount++;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const c = JSON.parse(l.trim());
        const token = c.message?.content || '';
        fullContent += token;

        if (token.includes('<think>') && thinkStartTime === null) {
          thinkStartTime = Date.now();
        }
        if (token.includes('</think>') && thinkEndTime === null) {
          thinkEndTime = Date.now();
        }
      } catch {}
    }
  }

  const totalTimeMs = Date.now() - startTime;
  const thinkingDurationMs = (thinkStartTime && thinkEndTime) ? (thinkEndTime - thinkStartTime) : null;
  const avgChunkGapMs = chunkGaps.length > 0 ? (chunkGaps.reduce((a, b) => a + b, 0) / chunkGaps.length) : 0;

  const result = {
    model: 'qwen3.5:9b',
    prompt,
    totalChunks: chunkCount,
    totalTimeMs,
    thinkingDurationMs,
    maxChunkGapMs,
    avgChunkGapMs: Math.round(avgChunkGapMs * 10) / 10,
    hasThinkingTokens: fullContent.includes('<think>'),
    contentLength: fullContent.length
  };

  console.log(`Results:`);
  console.log(`  Total Generation Time: ${totalTimeMs} ms (${(totalTimeMs / 1000).toFixed(1)} s)`);
  console.log(`  Thinking Duration: ${thinkingDurationMs || 'N/A'} ms`);
  console.log(`  Total Chunks Received: ${chunkCount}`);
  console.log(`  Max Chunk Gap: ${maxChunkGapMs} ms`);
  console.log(`  Average Chunk Gap: ${result.avgChunkGapMs} ms`);

  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'long_thinking_qwen35_measurement.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Saved measurement: ${outPath}`);

  return result;
}

measureLongThinking().catch(console.error);
