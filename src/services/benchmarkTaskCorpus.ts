import { BenchmarkTask } from './evaluationService';

/**
 * Deliverable 9.0: Comprehensive 30-Task Benchmark Corpus for Local 7B-9B LLMs.
 * Covers:
 * - 10 code_repair tasks
 * - 8 feature_gen tasks
 * - 6 refactor tasks
 * - 6 tool_use tasks
 */
export const BENCHMARK_CORPUS_30: BenchmarkTask[] = [
  // ==================== CODE REPAIR (10 tasks) ====================
  {
    id: 'repair-01-null-deref',
    name: 'Null Reference Repair in Property Access',
    category: 'code_repair',
    prompt: 'Fix the null pointer bug in getUserName so it safely returns "Guest" when user or user.name is null or undefined:\nfunction getUserName(user) { return user.name; }',
    expectedOutputs: {
      mustContain: ['user?.name', '?? "Guest"', '|| "Guest"', 'if (!user']
    }
  },
  {
    id: 'repair-02-off-by-one',
    name: 'Off-by-One Array Boundary Error',
    category: 'code_repair',
    prompt: 'Fix the off-by-one loop boundary bug in sumArray that causes an out-of-bounds undefined addition:\nfunction sumArray(nums: number[]): number {\n  let total = 0;\n  for (let i = 0; i <= nums.length; i++) { total += nums[i]; }\n  return total;\n}',
    expectedOutputs: {
      mustContain: ['i < nums.length', 'total += nums[i]'],
      mustNotContain: ['i <= nums.length']
    }
  },
  {
    id: 'repair-03-async-missing-await',
    name: 'Async Promise Missing Await',
    category: 'code_repair',
    prompt: 'Fix the async bug in fetchUserData where the promise is returned unawaited inside a try/catch:\nasync function fetchUserData(fetcher: () => Promise<string>): Promise<string> {\n  try {\n    return fetcher();\n  } catch (err) {\n    return "default";\n  }\n}',
    expectedOutputs: {
      mustContain: ['return await fetcher()', 'const res = await fetcher()']
    }
  },
  {
    id: 'repair-04-type-coercion-equality',
    name: 'Type Coercion Loose Equality Bug',
    category: 'code_repair',
    prompt: 'Fix isStrictlyPositive to use strict equality and verify the value is a number greater than zero:\nfunction isStrictlyPositive(val: any): boolean {\n  return val == true;\n}',
    expectedOutputs: {
      mustContain: ['typeof val === "number"', 'val > 0', 'typeof val === \'number\'']
    }
  },
  {
    id: 'repair-05-unhandled-json-parse',
    name: 'Unhandled JSON Parse Exception',
    category: 'code_repair',
    prompt: 'Fix safeJsonParse so that it returns fallbackValue if JSON.parse throws:\nfunction safeJsonParse<T>(raw: string, fallback: T): T {\n  return JSON.parse(raw);\n}',
    expectedOutputs: {
      mustContain: ['try {', 'catch', 'return fallback']
    }
  },
  {
    id: 'repair-06-division-by-zero',
    name: 'Division by Zero Guard',
    category: 'code_repair',
    prompt: 'Fix calculateRatio so it returns 0 or throws an error when divisor is zero:\nfunction calculateRatio(a: number, b: number): number {\n  return a / b;\n}',
    expectedOutputs: {
      mustContain: ['b === 0', 'return 0', 'throw new Error']
    }
  },
  {
    id: 'repair-07-regex-special-char-escape',
    name: 'Regex Special Character Escaping',
    category: 'code_repair',
    prompt: 'Fix createExactWordRegex so that special characters in word are escaped before constructing the RegExp:\nfunction createExactWordRegex(word: string): RegExp {\n  return new RegExp(word, "g");\n}',
    expectedOutputs: {
      mustContain: ['replace', '/[.*+?^${}()|[\\]\\\\]/g', '\\\\$&']
    }
  },
  {
    id: 'repair-08-unbound-this-callback',
    name: 'Unbound This in Event Callback',
    category: 'code_repair',
    prompt: 'Fix Counter.start so that this.count correctly increments when setInterval triggers:\nclass Counter {\n  count = 0;\n  start() {\n    setInterval(function() { this.count++; }, 1000);\n  }\n}',
    expectedOutputs: {
      mustContain: ['() => {', 'this.count++', 'bind(this)']
    }
  },
  {
    id: 'repair-09-array-mutation-sort',
    name: 'In-Place Array Mutation in Sort',
    category: 'code_repair',
    prompt: 'Fix getSortedCopy so it does NOT mutate the original input array:\nfunction getSortedCopy(items: number[]): number[] {\n  return items.sort((a, b) => a - b);\n}',
    expectedOutputs: {
      mustContain: ['[...items]', 'items.slice()', '.sort((a, b)']
    }
  },
  {
    id: 'repair-10-missing-return-branch',
    name: 'Missing Return in Conditional Branch',
    category: 'code_repair',
    prompt: 'Fix checkPermission so all execution paths return a boolean value:\nfunction checkPermission(role: string): boolean {\n  if (role === "admin") return true;\n  if (role === "editor") return true;\n}',
    expectedOutputs: {
      mustContain: ['return false', 'role === "admin"']
    }
  },

  // ==================== FEATURE GENERATION (8 tasks) ====================
  {
    id: 'feature-01-filter-active',
    name: 'Active Items Filter Feature',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function filterActiveUsers(users: Array<{ id: string; active: boolean }>) that returns only active users.',
    expectedOutputs: {
      mustContain: ['filterActiveUsers', 'users.filter', 'user.active']
    }
  },
  {
    id: 'feature-02-paginate-array',
    name: 'Array Pagination Utility',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function paginate<T>(items: T[], page: number, pageSize: number): T[] that returns the sliced page (1-indexed page).',
    expectedOutputs: {
      mustContain: ['paginate', 'items.slice', 'pageSize']
    }
  },
  {
    id: 'feature-03-debounce-function',
    name: 'Debounce Wrapper Utility',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function debounce<T extends (...args: any[]) => void>(fn: T, delayMs: number): (...args: Parameters<T>) => void that cancels previous timers.',
    expectedOutputs: {
      mustContain: ['debounce', 'clearTimeout', 'setTimeout']
    }
  },
  {
    id: 'feature-04-key-by',
    name: 'Collection Key-By Map Builder',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function keyBy<T>(items: T[], key: keyof T): Record<string, T> that indexes an array of objects by a property.',
    expectedOutputs: {
      mustContain: ['keyBy', 'reduce', 'Record<string, T>']
    }
  },
  {
    id: 'feature-05-retry-async',
    name: 'Retry Async Operation with Exponential Backoff',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function retryAsync<T>(fn: () => Promise<T>, retries: number): Promise<T> that catches errors and retries up to retries times.',
    expectedOutputs: {
      mustContain: ['retryAsync', 'while', 'try', 'catch', 'await fn()']
    }
  },
  {
    id: 'feature-06-lru-cache',
    name: 'Simple LRU Cache Class',
    category: 'feature_gen',
    prompt: 'Write a TypeScript class SimpleLRU<K, V> with capacity, get(key: K): V | undefined, and set(key: K, val: V): void using a Map.',
    expectedOutputs: {
      mustContain: ['class SimpleLRU', 'Map', 'delete', 'set', 'get']
    }
  },
  {
    id: 'feature-07-chunk-array',
    name: 'Array Chunking Utility',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function chunkArray<T>(items: T[], size: number): T[][] that splits an array into subarrays of maximum length size.',
    expectedOutputs: {
      mustContain: ['chunkArray', 'for', 'slice', 'result.push']
    }
  },
  {
    id: 'feature-08-deep-clone',
    name: 'Deep Clone Utility for Plain Objects',
    category: 'feature_gen',
    prompt: 'Write a TypeScript function deepClone<T>(obj: T): T that recursively clones plain objects and arrays without mutating the input.',
    expectedOutputs: {
      mustContain: ['deepClone', 'Array.isArray', 'typeof obj === "object"']
    }
  },

  // ==================== REFACTORING (6 tasks) ====================
  {
    id: 'refactor-01-var-to-const',
    name: 'Modernize var declarations to const/let',
    category: 'refactor',
    prompt: 'Refactor the following code to use const and let instead of var, and arrow functions:\nvar count = 0;\nvar add = function(a, b) { return a + b; };',
    expectedOutputs: {
      mustContain: ['const add = (', 'count = 0'],
      mustNotContain: ['var count', 'var add']
    }
  },
  {
    id: 'refactor-02-extract-method',
    name: 'Extract Nested Validation Function',
    category: 'refactor',
    prompt: 'Refactor processOrder by extracting order line total calculation into a separate helper function computeLineTotal:\nfunction processOrder(order: { items: Array<{ price: number; qty: number }> }) {\n  let sum = 0;\n  for (const item of order.items) { sum += item.price * item.qty; }\n  return sum;\n}',
    expectedOutputs: {
      mustContain: ['computeLineTotal', 'processOrder', 'item.price * item.qty']
    }
  },
  {
    id: 'refactor-03-simplify-nested-ifs',
    name: 'Guard Clauses / Early Returns',
    category: 'refactor',
    prompt: 'Refactor handleRequest using early return guard clauses instead of nested if-else statements:\nfunction handleRequest(req: any) {\n  if (req) {\n    if (req.auth) {\n      if (req.auth.valid) {\n        return "AUTHORIZED";\n      } else {\n        return "INVALID_AUTH";\n      }\n    } else {\n      return "NO_AUTH";\n    }\n  } else {\n    return "NO_REQ";\n  }\n}',
    expectedOutputs: {
      mustContain: ['if (!req) return "NO_REQ"', 'if (!req.auth) return "NO_AUTH"', 'return "AUTHORIZED"']
    }
  },
  {
    id: 'refactor-04-callback-to-async',
    name: 'Convert Callback Pattern to Async/Await',
    category: 'refactor',
    prompt: 'Refactor loadConfigCallback to return a Promise and use async/await:\nfunction loadConfigCallback(cb: (err: Error | null, cfg?: any) => void) { ... }',
    expectedOutputs: {
      mustContain: ['async function loadConfig', 'Promise', 'resolve', 'reject']
    }
  },
  {
    id: 'refactor-05-switch-to-lookup-table',
    name: 'Convert Repetitive Switch to Record Lookup',
    category: 'refactor',
    prompt: 'Refactor getStatusLabel to use a Record<string, string> dictionary map instead of a verbose switch statement:\nfunction getStatusLabel(s: string): string {\n  switch(s) {\n    case "p": return "Pending";\n    case "a": return "Active";\n    case "c": return "Closed";\n    default: return "Unknown";\n  }\n}',
    expectedOutputs: {
      mustContain: ['Record<string, string>', 'Pending', 'Active', 'Closed'],
      mustNotContain: ['case "p":', 'case "a":']
    }
  },
  {
    id: 'refactor-06-replace-magic-numbers',
    name: 'Replace Magic Numbers with Named Constants',
    category: 'refactor',
    prompt: 'Refactor calculateTimeout using named consts SECONDS_PER_MINUTE = 60 and MS_PER_SECOND = 1000:\nfunction calculateTimeout(minutes: number): number {\n  return minutes * 60 * 1000;\n}',
    expectedOutputs: {
      mustContain: ['const SECONDS_PER_MINUTE = 60', 'const MS_PER_SECOND = 1000', 'return minutes * SECONDS_PER_MINUTE * MS_PER_SECOND']
    }
  },

  // ==================== TOOL USE / ORCHESTRATION (6 tasks) ====================
  {
    id: 'tool-01-read-file-json',
    name: 'Generate JSON Payload for readFile',
    category: 'tool_use',
    prompt: 'Generate an agent tool call JSON to read the file "src/index.ts". Output format: {"tool": "readFile", "args": {"path": "src/index.ts"}}',
    expectedOutputs: {
      mustContain: ['"tool": "readFile"', '"path": "src/index.ts"']
    }
  },
  {
    id: 'tool-02-run-test-command',
    name: 'Generate JSON Payload for runCommand',
    category: 'tool_use',
    prompt: 'Generate an agent tool call JSON to execute unit tests via npm test. Output format: {"tool": "runCommand", "args": {"command": "npm test"}}',
    expectedOutputs: {
      mustContain: ['"tool": "runCommand"', '"command": "npm test"']
    }
  },
  {
    id: 'tool-03-str-replace-patch',
    name: 'Generate Surgical String Replacement Patch JSON',
    category: 'tool_use',
    prompt: 'Generate an agent tool call JSON for patchFile replacing target "foo()" with replacement "bar()" in "src/utils.ts". Output format: {"tool": "patchFile", "args": {"path": "src/utils.ts", "target": "foo()", "replacement": "bar()"}}',
    expectedOutputs: {
      mustContain: ['"tool": "patchFile"', '"path": "src/utils.ts"', '"target": "foo()"', '"replacement": "bar()"']
    }
  },
  {
    id: 'tool-04-structured-plan-json',
    name: 'Generate Valid Plan JSON Schema',
    category: 'tool_use',
    prompt: 'Generate a JSON execution plan with schemaVersion 1, steps array with step id "1", description "Read file", tool "readFile", and empty dependsOn array.',
    expectedOutputs: {
      mustContain: ['"schemaVersion": 1', '"steps"', '"tool": "readFile"', '"dependsOn": []']
    }
  },
  {
    id: 'tool-05-impact-query-json',
    name: 'Generate Impact Analysis Tool Call',
    category: 'tool_use',
    prompt: 'Generate an agent tool call JSON to analyze the callers of symbol "calculateTax" in "src/finance.ts". Output format: {"tool": "findCallers", "args": {"symbol": "calculateTax", "file": "src/finance.ts"}}',
    expectedOutputs: {
      mustContain: ['"tool": "findCallers"', '"symbol": "calculateTax"', '"file": "src/finance.ts"']
    }
  },
  {
    id: 'tool-06-reproduction-command-json',
    name: 'Generate Diagnostic Reproduction Command JSON',
    category: 'tool_use',
    prompt: 'Generate an agent tool call JSON to run mocha for "test/unit/auth.test.ts". Output format: {"tool": "runCommand", "args": {"command": "npx mocha test/unit/auth.test.ts"}}',
    expectedOutputs: {
      mustContain: ['"tool": "runCommand"', 'mocha test/unit/auth.test.ts']
    }
  }
];

export interface BenchmarkComparison {
  baselineRunId: string;
  candidateRunId: string;
  model: string;
  baselinePassRate: number;
  candidatePassRate: number;
  deltaPassRate: number;
  categoryDeltas: Record<string, { baseline: number; candidate: number; delta: number }>;
  durationDeltaMs: number;
}

export function compareBenchmarkRuns(
  baseline: { runId: string; taskCompletionRate: number; totalDurationMs: number; categoryScores: Record<string, { passRate: number }> },
  candidate: { runId: string; model: string; taskCompletionRate: number; totalDurationMs: number; categoryScores: Record<string, { passRate: number }> }
): BenchmarkComparison {
  const categoryDeltas: Record<string, { baseline: number; candidate: number; delta: number }> = {};
  for (const cat of Object.keys(candidate.categoryScores)) {
    const baseScore = baseline.categoryScores[cat]?.passRate ?? 0;
    const candScore = candidate.categoryScores[cat]?.passRate ?? 0;
    categoryDeltas[cat] = {
      baseline: baseScore,
      candidate: candScore,
      delta: Math.round((candScore - baseScore) * 1000) / 1000
    };
  }

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    model: candidate.model,
    baselinePassRate: baseline.taskCompletionRate,
    candidatePassRate: candidate.taskCompletionRate,
    deltaPassRate: Math.round((candidate.taskCompletionRate - baseline.taskCompletionRate) * 1000) / 1000,
    categoryDeltas,
    durationDeltaMs: candidate.totalDurationMs - baseline.totalDurationMs
  };
}
