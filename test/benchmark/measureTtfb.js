const http = require('http');

async function testRequest(model, prompt, stream, thinkOpt) {
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream,
    options: {
      temperature: 0.2,
      num_ctx: 4096,
      num_predict: 256
    }
  };
  if (thinkOpt !== undefined) {
    payload.options.think = thinkOpt;
  }

  const start = Date.now();
  let ttfb = null;
  let totalTime = null;
  let chunksCount = 0;
  let hasThinkTag = false;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      ttfb = Date.now() - start;

      res.on('data', (chunk) => {
        chunksCount++;
        const str = chunk.toString();
        if (str.includes('<think>')) hasThinkTag = true;
      });

      res.on('end', () => {
        totalTime = Date.now() - start;
        resolve({
          model,
          stream,
          thinkOpt,
          ttfb,
          totalTime,
          chunksCount,
          hasThinkTag
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

async function main() {
  const prompt = 'remove the stray ``` lines from TaskItemsController.cs';
  console.log('--- Measuring TTFB and Total Time ---');

  for (const model of ['deepseek-r1:8b', 'qwen3.5:9b']) {
    console.log(`\nModel: ${model}`);

    // 1. stream: false
    try {
      const resNonStream = await testRequest(model, prompt, false);
      console.log(`  stream: false -> TTFB: ${resNonStream.ttfb}ms, Total: ${resNonStream.totalTime}ms, HasThink: ${resNonStream.hasThinkTag}`);
    } catch (e) {
      console.log(`  stream: false failed: ${e.message}`);
    }

    // 2. stream: true
    try {
      const resStream = await testRequest(model, prompt, true);
      console.log(`  stream: true  -> TTFB: ${resStream.ttfb}ms, Total: ${resStream.totalTime}ms, Chunks: ${resStream.chunksCount}, HasThink: ${resStream.hasThinkTag}`);
    } catch (e) {
      console.log(`  stream: true failed: ${e.message}`);
    }

    // 3. stream: true with think: false
    try {
      const resNoThink = await testRequest(model, prompt, true, false);
      console.log(`  stream: true (think: false) -> TTFB: ${resNoThink.ttfb}ms, Total: ${resNoThink.totalTime}ms, HasThink: ${resNoThink.hasThinkTag}`);
    } catch (e) {
      console.log(`  think: false failed: ${e.message}`);
    }
  }
}

main().catch(console.error);
