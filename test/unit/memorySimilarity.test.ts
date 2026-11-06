import * as assert from 'assert';
import { MemoryService } from '../../src/services/memoryService';
import { OllamaService } from '../../src/services/ollamaService';
import { resetMockState } from '../mocks/vscodeMock';

describe('Vector Memory & Semantic Search Baseline', () => {
  const testRoot = 'C:/Projects/test-workspace';
  let memory: MemoryService;
  let ollamaService: OllamaService;

  beforeEach(async () => {
    resetMockState(testRoot);
    ollamaService = new OllamaService('http://127.0.0.1:11434');
    memory = new MemoryService(ollamaService);
    await memory.init();
    await memory.clear();
  });

  it('should store memory items and retrieve count', async () => {
    assert.strictEqual(memory.getMemoryCount(), 0);

    await memory.storeMemoryItem('Always use Entity Framework Core InMemory for local unit testing', {
      category: 'architecture',
      tags: ['csharp', 'efcore']
    });

    assert.strictEqual(memory.getMemoryCount(), 1);

    await memory.storeMemoryItem('Frontend uses Angular Signals for reactive state', {
      category: 'architecture',
      tags: ['angular', 'signals']
    });

    assert.strictEqual(memory.getMemoryCount(), 2);
  });

  it('should rank items by semantic similarity', async () => {
    await memory.storeMemoryItem('Always use Entity Framework Core InMemory for local unit testing', {
      category: 'architecture'
    });
    await memory.storeMemoryItem('Frontend uses Angular Signals for reactive state', {
      category: 'architecture'
    });
    await memory.storeMemoryItem('Docker container configuration for PostgreSQL database', {
      category: 'architecture'
    });

    const results = await memory.semanticSearch('Entity Framework database testing', 3);
    assert.ok(results.length > 0);
    // Top result should be the EF Core item
    assert.ok(results[0].chunk.text.includes('Entity Framework Core'));
    assert.ok(results[0].similarity > 0);
  });

  it('should filter search results by category', async () => {
    await memory.storeMemoryItem('Decision: Prefer standalone components in Angular 19', {
      category: 'decision'
    });
    await memory.storeMemoryItem('Architecture: Clean architecture with Controller-Service-Repository', {
      category: 'architecture'
    });

    const decisionResults = await memory.semanticSearch('components', 5, 'decision');
    for (const r of decisionResults) {
      assert.strictEqual(r.chunk.metadata.category, 'decision');
    }

    const archResults = await memory.semanticSearch('components', 5, 'architecture');
    for (const r of archResults) {
      assert.strictEqual(r.chunk.metadata.category, 'architecture');
    }
  });
});
