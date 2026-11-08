const { OllamaService } = require('../../out/services/ollamaService');

async function main() {
  const service = new OllamaService('http://127.0.0.1:11434');
  console.log('Testing streaming tool calls on qwen2.5-coder:7b...');

  const payload = {
    model: 'qwen2.5-coder:7b',
    messages: [{ role: 'user', content: 'Use the ping tool with value 123' }],
    tools: [{
      type: 'function',
      function: {
        name: 'ping',
        description: 'Ping tool',
        parameters: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value']
        }
      }
    }],
    stream: true,
    options: { temperature: 0 }
  };

  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  console.log('HTTP Status:', res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let chunkIdx = 0;

  while (!done) {
    const { value, done: isDone } = await reader.read();
    if (isDone) break;
    const text = decoder.decode(value);
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) {
      chunkIdx++;
      try {
        const json = JSON.parse(line);
        console.log(`Chunk ${chunkIdx}: content="${json.message?.content || ''}", tool_calls=${JSON.stringify(json.message?.tool_calls || [])}, done=${json.done}`);
      } catch (e) {
        console.log(`Chunk ${chunkIdx} raw:`, line);
      }
    }
  }
}

main().catch(console.error);
