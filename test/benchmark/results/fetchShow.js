const fs = require('fs');
const path = require('path');

async function main() {
  const models = ['deepseek-r1:8b', 'qwen3.5:9b', 'qwen2.5-coder:7b'];
  for (const m of models) {
    const res = await fetch('http://127.0.0.1:11434/api/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m })
    });
    const text = await res.text();
    const outName = 'raw_show_' + m.replace(/[:.]/g, '_') + '.json';
    fs.writeFileSync(path.join(__dirname, outName), text);
  }
  console.log('Saved raw /api/show JSON files');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
