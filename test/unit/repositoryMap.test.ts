import * as assert from 'assert';
import * as vscode from 'vscode';
import { RepositoryMapService } from '../../src/services/repositoryMapService';
import { RepositoryIntelligenceService } from '../../src/services/repositoryIntelligenceService';
import { AtomicFileWriter } from '../../src/services/atomicFileWriter';

describe('Phase 9.1: Fast, Low-Token Incremental Repository Map Suite', () => {
  let repoMapService: RepositoryMapService;

  beforeEach(() => {
    RepositoryMapService.resetInstance();
    RepositoryIntelligenceService.resetInstance();
    repoMapService = RepositoryMapService.getInstance();
  });

  it('should incrementally index files and compute centrality scores', async () => {
    const fileA = vscode.Uri.file('c:/test-repo/src/core/auth.ts');
    const contentA = `
      export class AuthService {
        public login(user: string): boolean { return true; }
      }
    `;

    const fileB = vscode.Uri.file('c:/test-repo/src/controllers/userController.ts');
    const contentB = `
      import { AuthService } from '../core/auth';
      export class UserController {
        private auth = new AuthService();
      }
    `;

    const fileC = vscode.Uri.file('c:/test-repo/src/index.ts');
    const contentC = `
      import { AuthService } from './core/auth';
      import { UserController } from './controllers/userController';
      export function main() {}
    `;

    await repoMapService.indexFile(fileA, contentA);
    await repoMapService.indexFile(fileB, contentB);
    await repoMapService.indexFile(fileC, contentC);

    assert.strictEqual(repoMapService.getIndexSize(), 3);

    repoMapService.computeCentralityScores();
    const mapText = repoMapService.generateRepoMap({ maxTokens: 500 });

    assert.ok(mapText.includes('# REPOSITORY ARCHITECTURE MAP'));
    assert.ok(mapText.includes('auth.ts'));
    assert.ok(mapText.includes('userController.ts'));
    assert.ok(mapText.includes('index.ts'));
  });

  it('should reuse cached entry when content hash matches without re-extracting', async () => {
    const fileA = vscode.Uri.file('c:/test-repo/src/utils.ts');
    const content = 'export function helper(): string { return "ok"; }';

    const entry1 = await repoMapService.indexFile(fileA, content, 1000);
    const entry2 = await repoMapService.indexFile(fileA, content, 1000);

    // Exact reference equality confirms cache hit
    assert.strictEqual(entry1, entry2);
  });

  it('should respect maxTokens budget limit and truncate gracefully', async () => {
    for (let i = 0; i < 20; i++) {
      const uri = vscode.Uri.file(`c:/test-repo/src/file${i}.ts`);
      const code = `export class Service${i} { run() {} }`;
      await repoMapService.indexFile(uri, code);
    }

    // Set a very strict maxTokens limit (e.g. 50 tokens)
    const mapText = repoMapService.generateRepoMap({ maxTokens: 50 });
    assert.ok(mapText.includes('omitted to conserve token budget'));
  });

  it('should invalidate specific files when requested', async () => {
    const fileA = vscode.Uri.file('c:/test-repo/src/temp.ts');
    await repoMapService.indexFile(fileA, 'export const x = 1;');
    assert.strictEqual(repoMapService.getIndexSize(), 1);

    repoMapService.invalidateFile(fileA.fsPath);
    assert.strictEqual(repoMapService.getIndexSize(), 0);
  });
});
