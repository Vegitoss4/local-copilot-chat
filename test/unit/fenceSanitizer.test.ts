import * as assert from 'assert';
import { stripMarkdownFences, assertNoFenceLines } from '../../src/services/fenceSanitizer';

describe('Deliverable 5: File-Type Aware Markdown Fence Sanitizer Suite', () => {
  // Test A: Reproduce the original bug: C# controller wrapped in ```csharp
  it('should strip outer ```csharp fence and conversational prose from C# controller (bug reproduction)', () => {
    const rawModelOutput = `Here is the fixed TaskItemsController:

\`\`\`csharp
using Microsoft.AspNetCore.Mvc;
using Backend.Api.Models;

namespace Backend.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class TaskItemsController : ControllerBase
    {
        [HttpGet]
        public IActionResult Get() => Ok();
    }
}
\`\`\`

Hope this helps! Let me know if you need anything else.`;

    const result = stripMarkdownFences(rawModelOutput, 'Backend.Api/Controllers/TaskItemsController.cs');
    assert.strictEqual(result.strippedOuterWrapper, true);
    assert.strictEqual(result.hasInteriorFences, false);
    assert.strictEqual(result.warning, undefined);

    // Verify no backtick characters exist in sanitized code
    assert.ok(!result.sanitized.includes('```'));
    assert.ok(!result.sanitized.includes('Here is the fixed'));
    assert.ok(!result.sanitized.includes('Hope this helps'));
    assert.ok(result.sanitized.startsWith('using Microsoft.AspNetCore.Mvc;'));
    assert.ok(result.sanitized.endsWith('}'));

    // Verify assertion passes
    assert.doesNotThrow(() => {
      assertNoFenceLines(result.sanitized, 'Backend.Api/Controllers/TaskItemsController.cs');
    });
  });

  // Test B: README.md with several fenced blocks is written unchanged
  it('should preserve all interior code fences inside README.md intact', () => {
    const readmeContent = `# Fullstack App

To run the backend:
\`\`\`bash
dotnet run
\`\`\`

To run the frontend:
\`\`\`bash
ng serve
\`\`\`

Enjoy building!`;

    const result = stripMarkdownFences(readmeContent, 'README.md');
    // For markdown docs without an outer wrapper, content is preserved
    assert.strictEqual(result.hasInteriorFences, true);
    assert.strictEqual(result.warning, undefined); // No warning for doc files
    assert.ok(result.sanitized.includes('```bash\ndotnet run\n```'));
    assert.ok(result.sanitized.includes('```bash\nng serve\n```'));

    assert.doesNotThrow(() => {
      assertNoFenceLines(result.sanitized, 'README.md');
    });
  });

  // Test C: TypeScript file with a template literal containing a fence line is preserved with a warning
  it('should preserve interior fence line in TypeScript file (e.g. template literal) and issue a warning', () => {
    const tsCode = `export function formatCode(code: string): string {
  const template = \`
\`\`\`
\${code}
\`\`\`
\`;
  return template;
}`;

    const result = stripMarkdownFences(tsCode, 'src/utils/formatter.ts');
    assert.strictEqual(result.hasInteriorFences, true);
    assert.ok(result.warning !== undefined);
    assert.ok(result.warning.includes('formatter.ts'));
    assert.ok(result.warning.includes('interior Markdown fence lines'));

    // First and last lines are valid code (not fence lines), so assertNoFenceLines passes
    assert.doesNotThrow(() => {
      assertNoFenceLines(result.sanitized, 'src/utils/formatter.ts');
    });
  });

  // Test D: Unclosed fence
  it('should handle unclosed fence without crashing or corrupting', () => {
    const unclosed = `\`\`\`csharp
public class Incomplete {
    public int Id { get; set; }`;

    const result = stripMarkdownFences(unclosed, 'Models/Incomplete.cs');
    assert.ok(result.sanitized.length > 0);
  });

  // Test E: Nested fences
  it('should strip only the outer fence wrapper when nested fences exist', () => {
    const nested = `\`\`\`markdown
# Guide
Here is some code:
\`\`\`json
{"key": "value"}
\`\`\`
Done.
\`\`\``;

    const result = stripMarkdownFences(nested, 'guide.md');
    assert.strictEqual(result.strippedOuterWrapper, true);
    assert.ok(result.sanitized.includes('```json'));
    assert.ok(result.sanitized.includes('{"key": "value"}'));
    assert.ok(!result.sanitized.startsWith('```markdown'));
    assert.ok(!result.sanitized.endsWith('```\n```'));
  });

  // Test F: CRLF input preservation
  it('should preserve CRLF line endings when input uses CRLF', () => {
    const crlfInput = "```csharp\r\npublic class TaskItem\r\n{\r\n    public int Id { get; set; }\r\n}\r\n```";

    const result = stripMarkdownFences(crlfInput, 'Models/TaskItem.cs');
    assert.strictEqual(result.strippedOuterWrapper, true);
    assert.ok(result.sanitized.includes('\r\n'));
    assert.strictEqual(result.sanitized, "public class TaskItem\r\n{\r\n    public int Id { get; set; }\r\n}");

    assert.doesNotThrow(() => {
      assertNoFenceLines(result.sanitized, 'Models/TaskItem.cs');
    });
  });

  // Test G: assertNoFenceLines hard rejection on unstripped source file
  it('should reject source file starting or ending with a fence line', () => {
    const badSourceStart = "```csharp\npublic class Bad {}";
    assert.throws(
      () => assertNoFenceLines(badSourceStart, 'Bad.cs'),
      /begins with an unstripped Markdown fence line/
    );

    const badSourceEnd = "public class Bad {}\n```";
    assert.throws(
      () => assertNoFenceLines(badSourceEnd, 'Bad.cs'),
      /ends with an unstripped Markdown fence line/
    );
  });
});
