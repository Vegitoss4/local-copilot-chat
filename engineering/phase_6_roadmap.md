# Phase 6 Autonomous Engineering Capabilities — Roadmap & Architecture Specification

**Project:** `local-copilot-chat`  
**Execution Mode:** Autonomous Continuous Execution  
**Hardware Profile:** 8 GB VRAM budget (Ollama local inference, single-resident 7B/9B model)  
**Safety & Governance:** 100% offline determinism, fail-closed boundaries, 0 Git commits  

---

## 1. Overview and Engineering Objectives

Phase 6 elevates `local-copilot-chat` from a reactive coding assistant to an autonomous engineering system capable of end-to-end repository reasoning, defect localization, verified multi-file code generation, multi-agent orchestration, and regression prevention.

Each sub-phase is designed to function strictly within local workstation resources:
- Lightweight AST / regex symbol extraction and dependency analysis (no heavy external language servers required).
- Deterministic, patch-based surgical code editing with ambiguity detection and automated rollback.
- Sequential, single-resident agent execution preserving the 8 GB VRAM envelope.
- Repeatable offline evaluation harnesses and regression selectors.

---

## 2. Phase 6 Breakdown and Technical Specifications

### Phase 6.1: Evaluation and Benchmarking Framework
- **Problem:** Absence of programmatic, repeatable offline benchmarking to measure code generation accuracy, patch validity, tool adherence, and hallucination rates across model weights.
- **Architecture:**
  - `EvaluationBenchmarkSuite`: benchmark runner capable of loading declarative task definitions (`BenchmarkTask`: name, description, workspaceSetup, prompt, expectedFiles, verificationScript/evaluator).
  - Metric calculations: Patch Application Rate (PAR), Syntax/Compilation Validity (SCV), Task Completion Rate (TCR), Token Efficiency Ratio (TER).
  - Deterministic offline baseline runner running against mock or local Ollama endpoints with zero network calls.
  - Result persistence to `.vscode/local-copilot/benchmarks/benchmark-results.json` using `AtomicFileWriter`.

### Phase 6.2: Code Understanding & Repository Intelligence
- **Problem:** Token window exhaustion and hallucination when answering questions or generating code across larger workspaces. RAG requires structured code symbol graphs, not just raw text embeddings.
- **Architecture:**
  - `RepositoryIntelligenceService`:
    - AST / lightweight regex-based symbol extractor for TypeScript, JavaScript, Python, and C# (`SymbolTable`: classes, interfaces, methods, functions, imports, exports).
    - Lightweight dependency graph generator: maps file-to-file import relationships and symbol call-sites.
    - Context budget optimizer: constructs focused context snippets prioritizing direct imports, interface definitions, and symbol declarations within a configurable token budget ceiling (e.g. 2,000 tokens).

### Phase 6.3: Autonomous Debugging
- **Problem:** Debugging currently requires manual user copy-pasting of error logs and back-and-forth guessing.
- **Architecture:**
  - `AutonomousDebuggerService`:
    - Structured error parser: parses stack traces, TypeScript compiler diagnostics, and test failure outputs (Mocha/Jest/Pytest).
    - Fault localization: maps stack trace frames and compiler line diagnostics to workspace source files and symbols.
    - Hypothesis generation and diagnostic plan: generates targeted inspection queries.
    - Automated test reproduction: runs focused test commands via `AgentToolService` with timeout safety and output capture to confirm defect reproduction.

### Phase 6.4: Autonomous Code Generation & Refactoring
- **Problem:** Multi-file code generation risks partial edits, broken imports, and syntax regressions if interrupted or poorly coordinated.
- **Architecture:**
  - `CodeGenerationEngine`:
    - Multi-file plan validator: validates file dependencies before modifying disks.
    - Transactional multi-file patch applier: creates in-memory backup snapshots before applying edits; rolls back all files if any single file patch or syntax check fails.
    - Conflict detector: verifies baseline hashes/content before applying diffs.
    - Post-generation verification: triggers quick syntax/compilation validation.

### Phase 6.5: Agent Planning and Orchestration
- **Problem:** Swarm orchestrator lacks specialized autonomous roles (Architect, Researcher, Developer, Tester, Reviewer) and risk-aware task DAG execution under single-resident 8 GB VRAM.
- **Architecture:**
  - `AutonomousOrchestrationEngine`:
    - Role definitions and prompt specializations (`Architect`, `Developer`, `Reviewer`, `Tester`).
    - Task Dependency DAG: tasks specify dependencies (`dependsOn`), inputs, and acceptance criteria.
    - Sequential single-model execution: coordinates multi-agent handoffs while sharing pinned workspace whiteboard state without swapping competing models into VRAM concurrently.
    - Review gate: `Reviewer` role independently verifies `Developer` diffs against acceptance criteria before task closure.

### Phase 6.6: Regression Intelligence & Test Selection
- **Problem:** Running entire test suites on every minor edit wastes developer time and model cycles; running no tests causes undetected regressions.
- **Architecture:**
  - `RegressionIntelligenceService`:
    - Workspace diff analyzer: identifies modified files, functions, and symbols from `git diff` or working-tree changes.
    - Test-to-Code mapping: maps source files and exported symbols to test suites based on imports, naming conventions (`foo.ts` -> `foo.test.ts`), and dependency graph.
    - Targeted test selector: returns ranked, minimal subset of test commands to run for instant regression feedback.

---

## 3. Implementation Sequence & Quality Gates

Each sub-phase will follow the rigorous cycle:
1. Architecture audit & technical specification.
2. Implementation in `src/services/` or `src/evaluation/`.
3. Unit tests in `test/unit/` using mock VS Code and mock LLM.
4. Independent verification: `npm run compile`, `npm run compile:test`, `npm run test:unit`, `git diff --check`.
5. Journal entry in `engineering/engineering_execution_journal.md`.
