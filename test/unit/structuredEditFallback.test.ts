import * as assert from 'assert';
import * as vscode from 'vscode';
import { StructuredEditFallback } from '../../src/services/structuredEditFallback';

const SEARCH = '<'.repeat(7) + ' SEARCH';
const DIVIDER = '='.repeat(7);
const REPLACE = '>'.repeat(7) + ' REPLACE';

describe('Deliverable 3 & D: Structured-Edit Fallback Protocol Suite', () => {
  it('should parse Format 1: CREATE file block with full content and clean fences', () => {
    const response = `I will create the task model:

FILE: src/models/task.ts
\`\`\`typescript
export interface Task {
  id: string;
  title: string;
  completed: boolean;
}
\`\`\`

File creation ready.`;

    const result = StructuredEditFallback.parseBlocks(response);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.operations.length, 1);
    assert.strictEqual(result.operations[0].type, 'create');
    assert.strictEqual(result.operations[0].filePath, 'src/models/task.ts');
    assert.ok(result.operations[0].content?.includes('export interface Task'));
    // Outer fences should be stripped
    assert.ok(!result.operations[0].content?.startsWith('```'));
  });

  it('should parse Format 2: SEARCH/REPLACE block with exact lines', () => {
    const response = `I will fix the port in the service:

FILE: src/services/api.ts
${SEARCH}
const API_URL = 'http://localhost:5000';
${DIVIDER}
const API_URL = 'https://localhost:7041';
${REPLACE}

Updated port.`;

    const result = StructuredEditFallback.parseBlocks(response);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.operations.length, 1);
    assert.strictEqual(result.operations[0].type, 'modify');
    assert.strictEqual(result.operations[0].filePath, 'src/services/api.ts');
    assert.strictEqual(result.operations[0].oldString, "const API_URL = 'http://localhost:5000';");
    assert.strictEqual(result.operations[0].newString, "const API_URL = 'https://localhost:7041';");
  });

  it('should parse Format 3: DELETE_FILE command', () => {
    const response = `Removing unused file:
DELETE_FILE: src/deprecated.ts`;

    const result = StructuredEditFallback.parseBlocks(response);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.operations.length, 1);
    assert.strictEqual(result.operations[0].type, 'delete');
    assert.strictEqual(result.operations[0].filePath, 'src/deprecated.ts');
  });

  it('should reject duplicate file paths within the same response', () => {
    const response = `FILE: src/config.ts
${SEARCH}
const a = 1;
${DIVIDER}
const a = 2;
${REPLACE}

FILE: src/config.ts
${SEARCH}
const b = 1;
${DIVIDER}
const b = 2;
${REPLACE}`;

    const result = StructuredEditFallback.parseBlocks(response);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('Duplicate file path "src/config.ts"'));
  });

  it('should reject sensitive target files like .env or .git', () => {
    const response = `FILE: .env
\`\`\`bash
SECRET_KEY=leaked
\`\`\``;

    const result = StructuredEditFallback.parseBlocks(response);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('protected sensitive file'));
  });

  it('should reject paths with directory traversal sequences outside workspace', () => {
    const response = `FILE: ../../../etc/passwd
\`\`\`text
root
\`\`\``;

    const result = StructuredEditFallback.parseBlocks(response);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('traversal'));
  });
});
