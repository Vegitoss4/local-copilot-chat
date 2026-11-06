import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';

export interface MemoryMetadata {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  timestamp: number;
  agentOrigin: string; // 'orchestrator' | 'planner' | 'coder' | 'tester' | 'user'
  category: 'code' | 'decision' | 'architecture' | 'preference' | 'plan';
  tags?: string[];
}

export interface MemoryChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: MemoryMetadata;
}

export interface SearchResult {
  chunk: MemoryChunk;
  similarity: number;
}

export class MemoryService {
  private static instance: MemoryService | null = null;
  private ollamaService: OllamaService;
  private embeddingModel: string = 'nomic-embed-text';
  private chunks: MemoryChunk[] = [];
  private isLoaded: boolean = false;
  private memoryDirUri: vscode.Uri | null = null;
  private memoryFileUri: vscode.Uri | null = null;

  constructor(ollamaService: OllamaService) {
    this.ollamaService = ollamaService;
  }

  public static getInstance(ollamaService: OllamaService): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService(ollamaService);
    }
    return MemoryService.instance;
  }

  /**
   * Initializes workspace paths and loads existing vector memory from .vscode/local-copilot/memory.json
   */
  public async init(): Promise<void> {
    if (this.isLoaded) return;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.isLoaded = true;
      return;
    }

    const rootUri = folders[0].uri;
    this.memoryDirUri = vscode.Uri.joinPath(rootUri, '.vscode', 'local-copilot');
    this.memoryFileUri = vscode.Uri.joinPath(this.memoryDirUri, 'memory.json');

    try {
      await vscode.workspace.fs.createDirectory(this.memoryDirUri);
      await this.loadFromDisk();
    } catch (err) {
      console.warn('MemoryService init notice:', err);
    }

    this.isLoaded = true;
  }

  /**
   * Generates embedding vector via Ollama POST /api/embeddings with nomic-embed-text
   * Falls back to a deterministic semantic hash vector if Ollama embedding service is unreachable.
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    const endpoint = this.ollamaService.getEndpoint();
    try {
      const response = await fetch(`${endpoint}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: text.slice(0, 4000)
        })
      });

      if (response.ok) {
        const data = (await response.json()) as { embedding?: number[] };
        if (data.embedding && Array.isArray(data.embedding)) {
          return data.embedding;
        }
      }
    } catch {
      // Fallback below
    }

    // High-performance fallback: 768-dimensional token n-gram feature hashing
    return this.generateFallbackEmbedding(text);
  }

  /**
   * Stores a high-level architectural decision, user preference, or plan into long-term vector memory
   */
  public async storeMemoryItem(
    content: string,
    metadata: Partial<MemoryMetadata> & { category: MemoryMetadata['category'] }
  ): Promise<MemoryChunk> {
    await this.init();

    const fullMetadata: MemoryMetadata = {
      filePath: metadata.filePath,
      startLine: metadata.startLine,
      endLine: metadata.endLine,
      timestamp: metadata.timestamp || Date.now(),
      agentOrigin: metadata.agentOrigin || 'orchestrator',
      category: metadata.category,
      tags: metadata.tags || []
    };

    const embedding = await this.generateEmbedding(content);
    const chunk: MemoryChunk = {
      id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text: content,
      embedding,
      metadata: fullMetadata
    };

    this.chunks.push(chunk);
    await this.saveToDisk();

    return chunk;
  }

  /**
   * Chunks and indexes a file into the vector memory
   */
  public async indexFile(filePath: string, content: string, agentOrigin: string = 'planner'): Promise<number> {
    await this.init();

    // Remove existing chunks for this file to prevent duplicates
    this.chunks = this.chunks.filter(c => c.metadata.filePath !== filePath);

    const textChunks = this.chunkText(content, 1200, 200);
    let added = 0;

    for (let i = 0; i < textChunks.length; i++) {
      const chunkText = textChunks[i];
      const embedding = await this.generateEmbedding(chunkText);
      this.chunks.push({
        id: `chunk_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        text: chunkText,
        embedding,
        metadata: {
          filePath,
          timestamp: Date.now(),
          agentOrigin,
          category: 'code'
        }
      });
      added++;
    }

    await this.saveToDisk();
    return added;
  }

  /**
   * Performs cosine similarity semantic search across memory chunks
   */
  public async semanticSearch(
    query: string,
    limit: number = 3,
    category?: string
  ): Promise<SearchResult[]> {
    await this.init();

    if (this.chunks.length === 0) {
      return [];
    }

    const queryEmbedding = await this.generateEmbedding(query);

    const results: SearchResult[] = [];
    for (const chunk of this.chunks) {
      if (category && category !== 'all' && chunk.metadata.category !== category) {
        continue;
      }

      const similarity = this.calculateCosineSimilarity(queryEmbedding, chunk.embedding);
      results.push({ chunk, similarity });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, Math.max(1, limit));
  }

  public getMemoryCount(): number {
    return this.chunks.length;
  }

  public async clear(): Promise<void> {
    this.chunks = [];
    await this.saveToDisk();
  }

  /**
   * Saves memory chunks to .vscode/local-copilot/memory.json
   */
  public async saveToDisk(): Promise<void> {
    if (!this.memoryFileUri || !this.memoryDirUri) return;

    try {
      await vscode.workspace.fs.createDirectory(this.memoryDirUri);
      const json = JSON.stringify(this.chunks, null, 2);
      const buffer = new TextEncoder().encode(json);
      await vscode.workspace.fs.writeFile(this.memoryFileUri, buffer);
    } catch (err) {
      console.warn('Failed to save memory.json:', err);
    }
  }

  /**
   * Loads memory chunks from .vscode/local-copilot/memory.json
   */
  public async loadFromDisk(): Promise<void> {
    if (!this.memoryFileUri) return;

    try {
      const data = await vscode.workspace.fs.readFile(this.memoryFileUri);
      const text = new TextDecoder('utf-8').decode(data);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        this.chunks = parsed;
      }
    } catch {
      // File doesn't exist yet, start with empty array
      this.chunks = [];
    }
  }

  private calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private chunkText(text: string, maxChars: number = 1200, overlap: number = 200): string[] {
    if (text.length <= maxChars) {
      return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + maxChars;
      if (end < text.length) {
        const lastNewline = text.lastIndexOf('\n', end);
        if (lastNewline > start + (maxChars / 2)) {
          end = lastNewline;
        }
      } else {
        end = text.length;
      }

      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      if (end >= text.length) break;
      start = end - overlap;
    }

    return chunks;
  }

  /**
   * Fast 768-dimensional token n-gram feature hashing fallback vector
   */
  private generateFallbackEmbedding(text: string): number[] {
    const dim = 768;
    const vec = new Float64Array(dim);
    const words = text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(Boolean);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      // Unigram hash
      let h1 = 5381;
      for (let j = 0; j < word.length; j++) {
        h1 = ((h1 << 5) + h1) + word.charCodeAt(j);
      }
      const idx1 = Math.abs(h1) % dim;
      vec[idx1] += 1.0;

      // Bigram hash
      if (i < words.length - 1) {
        const bigram = word + '_' + words[i + 1];
        let h2 = 5381;
        for (let k = 0; k < bigram.length; k++) {
          h2 = ((h2 << 5) + h2) + bigram.charCodeAt(k);
        }
        const idx2 = Math.abs(h2) % dim;
        vec[idx2] += 1.5;
      }
    }

    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vec[i] /= norm;
      }
    }

    return Array.from(vec);
  }
}
