import * as path from 'path';

export interface TestMapping {
  sourceFile: string;
  associatedTests: string[];
}

export interface SelectedTestsResult {
  modifiedFiles: string[];
  affectedTestFiles: string[];
  recommendedCommand?: string;
  requiresFullSuite: boolean;
  reason: string;
}

export class RegressionIntelligenceService {
  private static _instance?: RegressionIntelligenceService;
  private _testFileIndex: Set<string> = new Set();
  private _importToTestMap: Map<string, Set<string>> = new Map();
  private _sourceDependentsMap: Map<string, Set<string>> = new Map();

  public static getInstance(): RegressionIntelligenceService {
    if (!this._instance) {
      this._instance = new RegressionIntelligenceService();
    }
    return this._instance;
  }

  /**
   * Clears the index.
   */
  public clear(): void {
    this._testFileIndex.clear();
    this._importToTestMap.clear();
    this._sourceDependentsMap.clear();
  }

  /**
   * Registers a dependency edge between source files: caller imports dependency.
   */
  public registerSourceDependency(callerPath: string, dependencyPath: string): void {
    const normCaller = path.normalize(callerPath).toLowerCase();
    const normDep = path.normalize(dependencyPath).toLowerCase();
    let callers = this._sourceDependentsMap.get(normDep);
    if (!callers) {
      callers = new Set();
      this._sourceDependentsMap.set(normDep, callers);
    }
    callers.add(normCaller);
  }

  /**
   * Registers a test file and its imported sources into the regression index.
   */
  public registerTestFile(testFilePath: string, importedSources: string[] = []): void {
    const normTest = path.normalize(testFilePath).toLowerCase();
    this._testFileIndex.add(normTest);

    for (const src of importedSources) {
      const normSrc = path.normalize(src).toLowerCase();
      let testSet = this._importToTestMap.get(normSrc);
      if (!testSet) {
        testSet = new Set();
        this._importToTestMap.set(normSrc, testSet);
      }
      testSet.add(normTest);
    }
  }

  /**
   * Analyzes modified files, resolves transitive callers, and selects the targeted tests.
   * Escalates to full suite if dependency analysis is uncertain or tests are missing.
   */
  public selectTargetedTests(
    modifiedFiles: string[],
    dependencyGraph?: { outgoing?: Record<string, string[]>; incoming?: Record<string, string[]> }
  ): SelectedTestsResult {
    if (!modifiedFiles || modifiedFiles.length === 0) {
      return {
        modifiedFiles: [],
        affectedTestFiles: [],
        requiresFullSuite: false,
        reason: 'No files modified'
      };
    }

    const affected = new Set<string>();
    let requiresFullSuite = false;
    let fullSuiteReason = '';

    // Expand modified files using transitive closure of dependents
    const expandedFiles = new Set<string>();
    for (const modFile of modifiedFiles) {
      const normMod = path.normalize(modFile).toLowerCase();
      expandedFiles.add(normMod);

      const queue = [normMod];
      const visited = new Set<string>([normMod]);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        const callersFromGraph = dependencyGraph?.incoming?.[curr] || [];
        const callersFromInternal = this._sourceDependentsMap.get(curr) ? Array.from(this._sourceDependentsMap.get(curr)!) : [];
        const allCallers = Array.from(new Set([...callersFromGraph, ...callersFromInternal]));

        for (const caller of allCallers) {
          const normCaller = path.normalize(caller).toLowerCase();
          if (!visited.has(normCaller)) {
            visited.add(normCaller);
            queue.push(normCaller);
            expandedFiles.add(normCaller);
          }
        }
      }
    }

    for (const file of expandedFiles) {
      const normFile = path.normalize(file).toLowerCase();
      const baseName = path.basename(normFile);

      // Check for global / root configuration changes that require full suite
      if (
        baseName === 'package.json' ||
        baseName === 'tsconfig.json' ||
        baseName === 'tsconfig.test.json' ||
        normFile.includes('types.ts') ||
        normFile.includes('setup.ts')
      ) {
        requiresFullSuite = true;
        fullSuiteReason = `Core configuration or shared type file modified: ${baseName}`;
      }

      // Check if file is itself a test file
      if (this._isTestFile(normFile)) {
        affected.add(normFile);
      }

      // Direct import mapping: tests that explicitly import this file
      const directDependents = this._importToTestMap.get(normFile);
      if (directDependents) {
        for (const t of directDependents) {
          affected.add(t);
        }
      }

      // Naming convention heuristic: foo.ts -> foo.test.ts or foo.spec.ts
      const stem = baseName.replace(/\.(ts|js|tsx|jsx|py|cs)$/, '');
      for (const registeredTest of this._testFileIndex) {
        const testBase = path.basename(registeredTest);
        if (
          testBase === `${stem}.test.ts` ||
          testBase === `${stem}.spec.ts` ||
          testBase === `${stem}.test.js` ||
          testBase === `test_${stem}.py`
        ) {
          affected.add(registeredTest);
        }
      }
    }

    // Safety rule: if files were modified but no tests were found, escalate to full suite
    if (!requiresFullSuite && affected.size === 0 && modifiedFiles.length > 0) {
      requiresFullSuite = true;
      fullSuiteReason = 'No targeted tests found for modified files or dependency coverage uncertain. Escalating to full test suite.';
    }

    const affectedList = Array.from(affected);

    let recommendedCommand: string | undefined = undefined;
    if (requiresFullSuite) {
      recommendedCommand = 'npm test';
    } else if (affectedList.length > 0) {
      const testArgs = affectedList.map(t => `"${t}"`).join(' ');
      recommendedCommand = `npx mocha ${testArgs}`;
    }

    return {
      modifiedFiles,
      affectedTestFiles: affectedList,
      recommendedCommand,
      requiresFullSuite,
      reason: requiresFullSuite
        ? fullSuiteReason
        : (affectedList.length > 0 ? `Selected ${affectedList.length} targeted test(s)` : 'No directly affected tests found')
    };
  }

  private _isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      lower.includes('.test.') ||
      lower.includes('.spec.') ||
      lower.includes('/test/') ||
      lower.includes('\\test\\') ||
      path.basename(lower).startsWith('test_')
    );
  }
}
