const fs = require('fs');
const path = require('path');
const os = require('os');
const { vscodeMock, nativeFetch } = require('../../out-test/test/setup.js');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-open-'));
  const filePath = path.join(tempDir, 'test.cs');
  fs.writeFileSync(filePath, 'using System;\n```\nclass Foo {}\n```');

  console.log('1. Testing unpatched openTextDocument:');
  try {
    await vscodeMock.workspace.openTextDocument(vscodeMock.Uri.file(filePath));
    console.log('   Unpatched succeeded unexpectedly!');
  } catch (e) {
    console.log('   Unpatched failed as expected:', e.message);
  }

  console.log('2. Testing patched openTextDocument (real filesystem bridge):');
  const origOpen = vscodeMock.workspace.openTextDocument;
  vscodeMock.workspace.openTextDocument = async (uri) => {
    try {
      return await origOpen(uri);
    } catch (e) {
      if (uri.fsPath && fs.existsSync(uri.fsPath)) {
        let currentText = fs.readFileSync(uri.fsPath, 'utf8');
        return {
          uri,
          fileName: uri.fsPath,
          getText: (range) => currentText,
          lineCount: currentText.split('\n').length
        };
      }
      throw e;
    }
  };

  const doc = await vscodeMock.workspace.openTextDocument(vscodeMock.Uri.file(filePath));
  console.log('   Patched succeeded! Doc text:\n', doc.getText());

  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch(console.error);
