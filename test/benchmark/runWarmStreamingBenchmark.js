const http = require('http');
const fs = require('fs');
const path = require('path');

async function sendRequest(model, prompt, stream, numPredict = 64) {
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream,
    options: {
      temperature: 0.1,
      num_ctx: 4096,
      num_predict: numPredict
    }
  };

  const postData = JSON.stringify(payload);
  const start = Date.now();
  let ttfb = null;
  let totalTime = null;
  let chunkCount = 0;
  let responseData = '';

  return new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      // First byte / header event
      const headerTime = Date.now() - start;

      res.on('data', (chunk) => {
        chunkCount++;
        if (ttfb === null) {
          ttfb = Date.now() - start;
        }
        responseData += chunk.toString();
      });

      res.on('end', () => {
        totalTime = Date.now() - start;
        let metadata = null;
        if (stream) {
          const lines = responseData.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.done) {
                metadata = {
                  eval_count: parsed.eval_count,
                  eval_duration: parsed.eval_duration,
                  prompt_eval_count: parsed.prompt_eval_count,
                  prompt_eval_duration: parsed.prompt_eval_duration
                };
              }
            } catch {}
          }
        } else {
          try {
            const parsed = JSON.parse(responseData);
            metadata = {
              eval_count: parsed.eval_count,
              eval_duration: parsed.eval_duration,
              prompt_eval_count: parsed.prompt_eval_count,
              prompt_eval_duration: parsed.prompt_eval_duration
            };
          } catch {}
        }

        resolve({
          model,
          stream,
          headerTimeMs: headerTime,
          ttfbMs: ttfb ?? headerTime,
          totalDurationMs: totalTime,
          chunkCount,
          numPredict,
          metadata
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

async function main() {
  const models = ['qwen2.5-coder:7b', 'qwen3.5:9b'];
  const prompt = 'Explain the difference between interface and abstract class in TypeScript in three short bullet points.';
  const results = {
    benchmark: 'Streaming vs Non-Streaming TTFB and Total Duration',
    timestamp: new Date().toISOString(),
    prompt,
    numPredict: 64,
    temperature: 0.1,
    runs: []
  };

  console.log('=== Starting Warm Model Streaming Measurement ===');

  for (const model of models) {
    console.log(`\n--- Warm-up for ${model} ---`);
    try {
      const warmup = await sendRequest(model, 'Ping', false, 16);
      console.log(`Warmup completed in ${warmup.totalDurationMs}ms`);
    } catch (err) {
      console.error(`Warmup failed for ${model}:`, err.message);
    }

    // 3 runs per model, alternating order:
    // Run 1: streaming, then non-streaming
    // Run 2: non-streaming, then streaming
    // Run 3: streaming, then non-streaming
    for (let r = 1; r <= 3; r++) {
      const order = r % 2 === 1 ? [true, false] : [false, true];
      console.log(`\n[${model}] Iteration ${r}/3 (Modes order: ${order.map(s => s ? 'stream' : 'non-stream').join(' -> ')})`);

      for (const streamMode of order) {
        try {
          const res = await sendRequest(model, prompt, streamMode, 64);
          console.log(`  Mode: ${streamMode ? 'STREAMING    ' : 'NON-STREAMING'}: TTFB = ${res.ttfbMs}ms (Headers: ${res.headerTimeMs}ms), Total = ${res.totalDurationMs}ms, Chunks = ${res.chunkCount}`);
          results.runs.push({
            iteration: r,
            model,
            mode: streamMode ? 'streaming' : 'non-streaming',
            headerTimeMs: res.headerTimeMs,
            ttfbMs: res.ttfbMs,
            totalDurationMs: res.totalDurationMs,
            chunkCount: res.chunkCount,
            metadata: res.metadata
          });
        } catch (err) {
          console.error(`  Mode: ${streamMode ? 'STREAMING' : 'NON-STREAMING'} failed:`, err.message);
          results.runs.push({
            iteration: r,
            model,
            mode: streamMode ? 'streaming' : 'non-streaming',
            error: err.message
          });
        }
      }
    }
  }

  const outPath = path.resolve(__dirname, 'results', 'streaming_ttfb_benchmark.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nResults written to: ${outPath}`);
}

main().catch(console.error);
