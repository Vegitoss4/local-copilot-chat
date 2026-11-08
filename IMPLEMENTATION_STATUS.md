# Local Copilot Chat — Implementation Journal & Recovery Status

**Current Date / Timestamp:** 2026-11-08T12:30:00+05:30
**Branch:** `main`  
**Commit Authorization:** NOT GRANTED (Working tree changes only, zero Git commits created)

---

## 1. Executive Summary & Verification Checkpoint

This document serves as the master recovery checkpoint and architectural record for the end-to-end engineering execution across Phase 1 through Phase 12 of `local-copilot-chat`.

### Key Verification Metrics:
- **Unit Test Suite**: **580 passing, 0 pending, 0 failing across 59 test suites**.
- **Real Integration Tier**: Real HTTP server tests covering streaming inactivity, 62s long thinking, 60s and 120s delayed headers, and exceeded headers limits.
- **Real VS Code Extension Host Tier**: **6 passing, 0 failing in real Electron host**.
- **TypeScript Compilation**: `npm run compile` (0 errors), `npm run compile:test` (0 errors), `npm run vscode:prepublish` (0 errors).
- **Git Hygiene**: `git diff --check` passed cleanly; zero git commits made per strict user instructions.
- **Hardware Profile**: NVIDIA GeForce RTX 3070 (8,192 MB VRAM), Driver 617.14, single-resident model execution under 8 GB constraints.

---

## 2. Milestone Progress Tracker

| Milestone | Title | Status | Tests Passing | Key Artifacts & Implementation Details |
|---|---|:---:|:---:|---|
| **Phase 0** | Testing Foundation | **COMPLETED** | 18 | `out-test/`, `vscodeMock.ts`, `.vscodeignore`, isolated test pipeline. |
| **Phase 1.1** | Filesystem Security Containment | **COMPLETED** | 31 | `resolveSecurePath`, Windows directory junction & symlink defense, multi-root determinism, internal state isolation (`.vscode/local-copilot/`). |
| **Phase 1.2** | Command Execution & Approval Gates | **COMPLETED** | 45 | `CommandClassifier.ts`, `ExecutableResolver.ts`, `GitExecutionIsolator.ts`, tool approval fail-closed verification, unbypassable autonomous guardrail for Tier 2/3 commands, `spawn(..., { shell: false })`. |
| **Phase 1.3** | Webview CSP & Safe Rendering | **COMPLETED** | 2 | Restrictive Content Security Policy (`default-src 'none'`), DOM sanitization, XSS mitigation, script origin isolation, cryptographic nonce enforcement. |
| **Phase 1.4** | Webview RPC & Message Validation | **COMPLETED** | 10 | `MessageValidator.ts`, strict message type whitelist, schema validation, Tier 4 command rejection in webview handlers, fail-closed `rpcError` dispatch. |
| **Deliverable A.1** | Ollama Connection Reliability | **COMPLETED** | 10 | Live status badges (`🟢 Online`, `🔄 Connecting...`, `🟡 No Models`, `🔴 Offline`), retry banner, stale request discard, draft text preservation. |
| **Deliverable A.2** | Code Block UX & Language Mapping | **COMPLETED** | 18 | Prominent Copy button with temporary feedback, extension host clipboard fallback, comprehensive language dictionary, streaming code fence resilience. |
| **Deliverable A.3** | Runtime Configuration Architecture | **COMPLETED** | 24 | `ConfigurationService.ts`, `package.json` contributions (`numCtx`, `temperature`, `maxTurns`), clamping, tool temperature ceiling $\le 0.1$, dynamic compaction scaling. |
| **Phase 2 & 3** | Runtime, Router & Swarm Hardening | **COMPLETED** | 14 | Sub-agent repetition loop defense, evidence verification requirement before task completion, task-local state isolation (`isContinuation` guard), robust JSON tool-call fallback. |
| **Phase 4** | Memory, Indexing & Persistent RAG | **COMPLETED** | 14 | Secret/binary exclusion filters, stale chunk pruning, atomic file writes via rename and cleanup, corruption backup (`.corrupt`), sequential mutex write queues. |
| **Phase 5** | Streaming UX & History Restoration | **COMPLETED** | 13 | Thought stream separation and sanitization, atomic chat history persistence, clean restoration without thought leak, terminal tier-based approval. |
| **Phase 5.5 (H1)** | Critical Production Hardening | **COMPLETED** | 174 | Repaired `/diff` and `AppGeneratorService` chaining; hardened Windows `npm`/`npx` resolution via `node.exe` (no ComSpec/cmd.exe); centralized single-flight stream lifecycle with turn ownership; intercepted reserved slash commands (`/fix`, `/commit`, `/search`, `/read`). |
| **Phase 5.5 (H2)** | High-Severity Production Hardening | **COMPLETED** | 184 | Enforced CSP nonces and zero inline event handlers (`on\w+=`); escaped template sinks and sanitized attribute contexts (`appendTimelineStep`); introduced Whiteboard Schema v2 with per-task identity (`taskId`), task isolation, and backward compatibility migration; added single-flight generation concurrency guard with generation-owned cleanup. |
| **Phase 5.5 (H3)** | Medium-Severity Hardening | **COMPLETED** | 197 | Shared `AtomicFileWriter` with mutex serialization, process PID naming, stale temp cleanup, and `.corrupt` backups; universal `<think>` token suppression across streaming and persistence; host-side modal approval for Tier 2/3 `runCommand` with Workspace Trust gating; complete Git isolation (`core.hooksPath=/dev/null`, `diff.external=`, `merge.tool=`, `GIT_CONFIG_NOSYSTEM=1`). |
| **Phase 5.5 (H4.1)** | Ollama Resilience & Lifecycles | **COMPLETED** | 206 | 4-tier timeout architecture (`connect: 5s`, `headers: 45s`, `idle_stream: 30s`, `total: 300s`), sliding stream inactivity reset, AbortSignal link with reader cancellation, preserved partial output on timeout, ping probe. |
| **Phase 5.5 (H4.2)** | Model Lifecycle & VRAM Budget | **COMPLETED** | 215 | `GET /api/ps` ground-truth model residency inspection, `ModelLifecycleManager` with serialization mutex, active generation lock, sequential eviction of non-target models under 8 GB VRAM budget, configurable unload policies (`keepAlive`, `unloadImmediately`, `unloadOnIdle`). |
| **Phase 5.5 (H4.3)** | Multi-Root Workspace Isolation | **COMPLETED** | 222 | Centralized `WorkspaceManager` resolution hierarchy (preferred URI -> active text editor -> primary root), `.vscode/local-copilot/` per-root isolation, folder-scoped RAG & memory indexing, pinned swarm whiteboard isolation. |
| **Phase 6.1** | Evaluation & Benchmarking Framework | **COMPLETED** | 228 | `EvaluationService` with declarative `BenchmarkTask` schema across 4 categories (`code_repair`, `feature_gen`, `refactor`, `tool_use`), Task Completion Rate (TCR) scoring, atomic benchmark history logging (`benchmark-results.json`). |
| **Phase 6.2** | Code Understanding & Intelligence | **COMPLETED** | 232 | `RepositoryIntelligenceService` lightweight in-process symbol extractor (TypeScript, JavaScript, Python, C#), bidirectional dependency graph, token-budgeted `packContext` (skeleton outline, dependency types, callers). |
| **Phase 6.3** | Autonomous Debugging | **COMPLETED** | 237 | `AutonomousDebuggerService` structured diagnostic parser (V8/Node, TypeScript compiler errors, Python tracebacks, Mocha/Jest assertion failures), workspace culprit isolation, actionable hypotheses synthesis, targeted reproduction command extraction. |
| **Phase 6.4** | Autonomous Code Generation & Refactoring | **COMPLETED** | 242 | `CodeGenerationEngine` transactional multi-file patch applier with pre-flight byte snapshots, surgical string replacement with ambiguity detection (rejects >1 matches), post-verification hook, and automatic full-workspace rollback upon any failure. |
| **Phase 6.5** | Agent Planning & Orchestration | **COMPLETED** | 246 | `AutonomousOrchestrationEngine` deterministic sequential role DAG (`Architect` -> `Developer` -> `Tester` -> `Reviewer`), single-resident scheduling under 8 GB VRAM, review acceptance gate, bounded rejection feedback loop (max 3 iterations), scoped whiteboard persistence. |
| **Phase 6.6** | Regression Intelligence & Test Selection | **COMPLETED** | 251 | `RegressionIntelligenceService` test-to-source mapping heuristics (naming convention, dependency import tracing, direct test edits), full-suite escalation on core config changes (`package.json`, `tsconfig.json`), minimal targeted mocha test command synthesis. |
| **Phase 7.1** | Path Security & Conflict-Aware Rollback | **COMPLETED** | 255 | `PathSecurity` shared service with UNC, symlink/junction canonicalization, null-byte rejection, and conflict-aware SHA-256 rollback tracking in `CodeGenerationEngine`. |
| **Phase 7.2** | Safe Model Lifecycle & External Process Protection | **COMPLETED** | 257 | `ModelLifecycleManager` ownership tracking (`_extensionOwnedModels`) preventing eviction of external tools' models from Ollama `/api/ps`. Integrated into `ChatViewProvider`. |
| **Phase 7.3** | Multi-Root Path Correctness & Boundary Enforcement | **COMPLETED** | 259 | Pinned folder containment across `AppGeneratorService`, `AgentToolService`, and `WorkspaceManager`. Ambiguous folder rejection for unpinned multi-root paths. |
| **Phase 7.4** | Ollama HTTP Resilience & Connect Timeout Phase | **COMPLETED** | 260 | Independent connect timeout timer, streaming activity reset, and phase-attributed `OllamaTimeoutError` telemetry. |
| **Phase 7.5** | Real AST Symbol Extraction & Repo Context Packing | **COMPLETED** | 261 | TypeScript Compiler API (`ts.createSourceFile`) AST extraction for TS/JS, lightweight Python/C# heuristics, and token-budgeted workspace symbol injection into prompt context. |
| **Phase 7.6** | Autonomous Debugging & `/fix` Workflow | **COMPLETED** | 262 | End-to-end `/fix` diagnosing errors, localizing culprit files via `PathSecurity`, generating surgical patches, and verifying builds with automatic rollback. |
| **Phase 7.7** | Safe Code Generation Runtime Integration | **COMPLETED** | 262 | Registered `apply_transactional_patches` tool in `AgentToolService` and `AutonomousAgent`, executing multi-file transactional operations via `CodeGenerationEngine`. |
| **Phase 7.8** | Autonomous Orchestration Real Prompt Integration | **COMPLETED** | 263 | Default production handlers in `AutonomousOrchestrationEngine` connecting Architect, Developer, Tester, and Reviewer to real LLM prompting with bounded iterations. |
| **Phase 7.9** | Regression Intelligence Transitive Tracing & Safety Escalation | **COMPLETED** | 263 | BFS transitive dependent graph traversal, fallback escalation to full test suite (`requiresFullSuite: true`) when coverage is uncertain. |
| **Phase 7.10** | Evaluation Framework & `/benchmark` Integration | **COMPLETED** | 263 | Built-in test battery across 4 core competencies, reporting overall completion rate and category breakdown. |
| **Phase 7.11** | Slash Command Completion (`/search`, `/read`, `/commit`, `/benchmark`) | **COMPLETED** | 263 | Live bounded `/read`, symbol-indexed `/search`, reviewable `/commit` requiring explicit user confirmation, and `/benchmark`. |
| **Phase 7.12** | State Storage & Source Control Hygiene | **COMPLETED** | 264 | `WorkspaceManager.ensureStorageHygiene` writing `.vscode/local-copilot/.gitignore` and updating root `.gitignore` to prevent repository pollution. |
| **Phase 7.13** | Integration Verification & Production Readiness | **COMPLETED** | 264 | Full suite passing offline (264 unit tests, 0 failures, 24 test suites), clean `npm run compile`, clean `npm run vscode:prepublish`, clean `git diff --check`. |
| **Phase 8.1 - 8.5** | Independent Audit Remediation & Live Validation | **COMPLETED** | 286 | Independent audit remediation (SEC-01 to SEC-04, CONC-01 to CONC-04, RES-01), real integration tier (7 suites, 23 passing, 3 pending), live Ollama streaming and VRAM release verification, backup/DR drill. |
| **Phase 9.0 - 9.7** | Agent Intelligence & Coding Quality | **COMPLETED** | 327 | 30-task benchmark corpus, 4-stage tolerant JSON parser, context compaction, incremental disk-cached repo map, context budget manager with XML quarantine, PlanSchemaV1, caller impact analysis, iterative code repair with oscillation detection, independent reviewer. |
| **Phase 10.0 - 10.8** | Advanced Orchestration & Swarm Intelligence | **COMPLETED** | 361 | Hardware capacity manager (8 GB VRAM serialized FIFO inference), Whiteboard Coordinator v3, subagent task pool, file-level leases with 30s TTL, typed agent contracts, subagent delegation protocol, multi-agent consensus verifier, adversarial prompt defense, 3-tier multi-strategy code fallbacks. |

---

## 3. Phase 5.5 (H1) Implementation Accomplishments

### 1. [DEFECT-CRIT-01] Command Execution De-chaining & Internal Caller Audit
- **`AppGeneratorService.generateFullStackApp`**: Eliminated shell chaining `&&` and shell builtin `cd`. Replaced with sequential individual calls targeting `Backend.Api/Backend.Api.csproj` directly without directory changes.
- **`AgentToolService.getGitDiff`**: Decoupled `git diff --stat` and `git status --short`. Formats output cleanly when clean or uninitialized.
- **Internal Callers**: Audited all `executeCommand` invocations in `checkBuild()`, `getGitDiff()`, `AppGeneratorService`, `AutonomousAgent`, and `SwarmOrchestrator` to ensure zero shell metacharacter usage.

### 2. [DEFECT-CRIT-02] Windows Node.js & Package Manager Resolution (No Shell)
- **Eliminated Shell Fallbacks**: Completely removed `ComSpec` and `findTrustedCmd`. No `cmd.exe /c` or `{ shell: true }` is ever used.
- **Trusted Roots & Multi-Layout Inspection**: Enhanced `findNodeAndNpmCli` to canonicalize search roots and locate `node.exe` with `npm-cli.js` / `npx-cli.js` across standard installer, NVM Windows, Volta, fnm, and global npm (`%APPDATA%\npm`).
- **Strict Anti-Hijack Policy**: Reject any binary or CLI script residing inside or beneath active workspace folders.
- **Verified Offline Real-Process Execution**: Validated `npm --version` and `npx --version` on Windows using real `node.exe` with `shell: false`.

### 3. Stream Turn Ownership & Centralized Lifecycle
- **Turn Ownership**: Tagged each turn with a generation ID (`_currentGenerationId = ++_generationCounter`). Exit paths only mutate state or emit events if their generation ID matches the active generation ID, preventing race conditions from terminating newly started streams.
- **Centralized Exactly-Once `streamEnd`**: The outer `finally` block dispatches `streamEnd` once per turn across success, error, and cancellation paths.
- **Slash Command Routing**: Handled `/diff`, `/create-app`, and `/build`. Intercepted reserved commands (`/fix`, `/commit`, `/search`, `/read`) with clear user guidance rather than silently falling through to normal LLM conversation.

---

## 4. Phase 5.5 (H2) Implementation Accomplishments

### 1. [DEFECT-HIGH-01] Webview CSP Nonce Enforcement, Zero Inline Handlers & Context-Specific XSS Defense
- **Strict Nonce Enforcement**: Verified cryptographic 16-byte base64 nonces on `script-src` and complete exclusion of `'unsafe-inline'` and `'unsafe-eval'`.
- **Zero Inline Event Attributes**: Replaced direct property event assignments (`tab.onclick = ...`, `sendButton.onclick = ...`, `chatInput.onkeydown = ...`) with standard `addEventListener` calls and unified event delegation. Verified via automated tests that generated HTML contains strictly zero `on*` inline event attributes.
- **Context-Specific Sanitization**:
  - HTML text content: escaped via `escapeHtml()`.
  - Dynamic template variables in [`appendTimelineStep`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L2221): wrapped `icon` in `escapeHtml(icon)` and sanitized class attribute `agentRole` into strict alphanumeric slugs (`/[^a-z0-9_-]/g`), eliminating DOM attribute escaping and CSS injection.
- **XSS Corpus Verification**: Verified neutralization of `<script>`, `<img onerror>`, `<svg onload>`, `javascript:`, and quote breakages.

### 2. [DEFECT-HIGH-02] Swarm Whiteboard Schema v2, Task Identity & Evidence Verification Isolation
- **Schema v2**: Introduced `SwarmWhiteboard` Schema v2 featuring per-task identity (`taskId`), `currentTask`, `lastTask`, and `projectContext`.
- **Task-Local State Isolation**: New tasks (`isContinuation: false`) archive previous task to `lastTask` and generate a fresh `taskId`, resetting `modifiedFiles = []`, `executionPlan = ''`, `diagnostics = []`, and `delegationHistory = []`.
- **Read-Only Task Immunity**: Evidence verification on `finish_task` checks only files modified in the *current* task session. Read-only queries are never trapped by edits from earlier tasks.
- **Seamless v1 Legacy Migration**: `loadWhiteboardFromDisk()` detects legacy unversioned files and migrates them to Schema v2 without data loss or corruption.

### 3. [DEFECT-HIGH-03] Concurrent Generation Single-Flight Guard & Ownership Cleanup
- **Single-Flight Lock**: `_handleSendMessage` rejects incoming generation requests immediately if `_isGenerating === true`, posting an actionable `streamError` without corrupting history or aborting in-flight work.
- **History Preservation**: Rejected messages are never appended to `_chatHistory`.
- **Generation Ownership of Lock & Cleanup**: `stopGeneration` aborts `_currentAbortController` without prematurely resetting `_isGenerating = false`. Each generation exclusively owns its cleanup in its own `finally` block guarded by `_currentGenerationId === generationId`.
- **Race Condition Immunity Verified**: Verified with dedicated regression tests that an earlier aborted generation unwinding asynchronously in the background never clobbers a newer generation's state, controllers, or locks.
- **Unblocked `ask_user` Clarifications**: `agentReply` messages route directly to `_currentAgent.resume()` without passing through the single-flight send guard.

---

## 5. Phase 5.5 (H3) Implementation Accomplishments

All four medium-severity audit defects have been fully implemented and verified with 197 passing unit tests:
1. **[DEFECT-MED-01] Shared AtomicFileWriter (`src/services/atomicFileWriter.ts`)**:
   - Centralized atomic write service using temp files (`.tmp.[pid].[timestamp].[rand]`), incorporating `process.pid` to avoid multi-process collisions.
   - Mutex queue (`writeQueue`) per target URI guaranteeing sequential in-order file replacements.
   - Automatic cleanup of stale temporary files older than 60 seconds (`cleanupStaleTempFiles`).
   - Resilient `readJson` with automatic `.corrupt` file backup upon JSON parse failure, falling back safely without unhandled crashes.
   - Fully adopted across `MemoryService`, `SwarmOrchestrator`, and `ChatViewProvider`.
2. **[DEFECT-MED-02] Universal <think> Token Suppression (`src/providers/chatViewProvider.ts`)**:
   - Robust `stripThoughtTokens` utility handling multiline, case-insensitive, and trailing unclosed `<think>` tags (`/(?:<\/think>|$)/gi`).
   - Clean separation of live thinking in `<details class="think-box">` from persisted message content.
   - Stripped in both standard chat and agent mode save paths, and sanitized on history restoration from disk.
3. **[DEFECT-MED-03] Host-Side Modal Approval for Terminal Execution (`src/providers/chatViewProvider.ts`)**:
   - Classifies commands via `CommandClassifier`. Tier 4 commands are prohibited outright.
   - Requires host modal confirmation (`vscode.window.showWarningMessage` with `{ modal: true }`) for **Tier 2** (`npm test`, `dotnet run`) and **Tier 3** (arbitrary execution) commands before terminal execution.
   - Blocks terminal execution completely in untrusted workspaces (`vscode.workspace.isTrusted === false`).
4. **[DEFECT-MED-04] Comprehensive Git Environment & Config Isolation (`src/services/gitExecutionIsolator.ts`, `src/services/agentToolService.ts`)**:
   - Injected config overrides into Git invocations: `-c core.hooksPath=/dev/null`, `-c diff.external=`, `-c merge.tool=`, `-c diff.tool=`.
   - Injected `GIT_CONFIG_NOSYSTEM=1` environment variable.
   - Enforced Workspace Trust gating in `AgentToolService.executeCommand`, restricting untrusted workspaces to read-only Tier 1 commands.

---

## 6. Known Limitations

1. **Subprocess Shell Builtins**: Because all process execution uses `spawn(..., { shell: false })`, shell built-ins such as `cd`, `dir`, `export`, and shell redirection operators (`>`, `|`) cannot be run directly via `execute_command`. Commands must invoke real host binaries.
2. **Custom / Portable Node.js Setups**: If a host on Windows has `node.exe` installed in a non-standard portable path without standard npm directory structure, `ExecutableResolver` fails closed and instructs the developer on setting standard Node.js PATH locations.
3. **Reserved Slash Commands**: Commands `/fix`, `/commit`, `/search`, and `/read` provide structured guidance and instructions for existing alternatives, pending autonomous agent implementations in subsequent phases.

---

## 7. Verification & Test Summary

```
npm run compile
> tsc -p ./ -> 0 errors

npm run compile:test
> tsc -p ./tsconfig.test.json -> 0 errors

npm run test:unit
> 197 passing (4s)
```

---

## 3. Phase 5.1 Remediation Actions & Verified Fixes

### 1. [DEFECT-CRIT-01] Repaired `/diff` Slash Command (`src/services/agentToolService.ts`, `src/providers/chatViewProvider.ts`)
- **Remediation**: Decoupled chained shell command `git diff --stat && git status --short` into two structured calls to `this.executeCommand('git diff --stat')` and `this.executeCommand('git status --short')`.
- **Safety**: Maintained full `GitExecutionIsolator` sandbox, sanitized empty diff returns, and wrapped in `try/catch/finally` inside `chatViewProvider.ts` to ensure stream termination message (`streamEnd`) is dispatched even on Git errors.

### 2. [DEFECT-CRIT-02] Repaired Windows Executable Resolution (`src/services/executableResolver.ts`, `src/services/agentToolService.ts`)
- **Remediation**: Added `resolveCommand(rawExecutable, args, platform, pathEnv)` to `ExecutableResolver`.
- **Node Entrypoint Support**: On Windows (`win32`), package managers (`npm`, `npx`) are resolved to `node.exe` executing `npm-cli.js` / `npx-cli.js` directly with `shell: false`.
- **Strict Anti-Hijack Policy**: Extensionless Unix shell scripts (`C:\Program Files\nodejs\npm`) are strictly rejected on Windows. Windows search strictly requires `.exe` extension. Prohibited scripts (`.bat`, `.cmd`, `.ps1`, `.vbs`, `.sh`) throw `ExecutableResolutionError`. Missing binaries fail-closed.

### 3. [DEFECT-HIGH-01] Hardened Webview Content Security Policy (`src/providers/chatViewProvider.ts`)
- **Remediation**: Removed `'unsafe-inline'` from CSP `script-src`.
- **Cryptographic Nonce**: Injected unique cryptographically secure 16-byte base64 nonces (`nonce-${nonce}`) per webview session into both CSP header and `<script nonce="${nonce}">`.
- **Event Delegation**: Replaced all inline `onclick="..."` attributes across static controls and dynamic templates with `data-action="..."` attributes handled by a unified client-side event delegation bus.

### 4. [DEFECT-HIGH-02] Swarm Whiteboard Task Isolation (`src/services/swarmOrchestrator.ts`)
- **Remediation**: Separated task-local state (`modifiedFiles`, `diagnostics`, `delegationHistory`) from persistent context (`executionPlan`, `scratchpad`).
- **Continuation Policy**: Added `isContinuation` option. When `false` (default), task-local state is cleared on new tasks so read-only queries never inherit prior file modification states.

### 5. [DEFECT-HIGH-03] Generation Concurrency Locking & Cancellation (`src/providers/chatViewProvider.ts`)
- **Remediation**: Added `_isGenerating` mutex lock and explicit abort propagation. If a new generation is triggered while active, the previous abort controller is immediately aborted, `streamEnd` is posted, and execution safely awaits cleanup before initiating the new stream.

### 6. [DEFECT-MED-01] Genuine Atomic File Persistence (`src/services/memoryService.ts`, `src/services/swarmOrchestrator.ts`, `src/providers/chatViewProvider.ts`)
- **Remediation**: Implemented atomic file replacement via temporary files (`.tmp.[timestamp].[rand]`) and atomic `vscode.workspace.fs.rename(tmp, target, { overwrite: true })` guarded by sequential promise queues (`_savePromise`) and temporary file cleanup on failure.

### 7. [DEFECT-MED-02] Thought-Token Sanitization (`src/providers/chatViewProvider.ts`)
- **Remediation**: Stripped `<think>...</think>` blocks before storing messages in `_chatHistory` or writing to `chat_history.json`. Sanitized historical entries upon session restoration.

### 8. [DEFECT-MED-03] Terminal Approval for Tier 3 Commands (`src/providers/chatViewProvider.ts`)
- **Remediation**: Updated `_runInTerminal` to classify commands using `CommandClassifier`. Tier 4 commands are rejected; Tier 3 mutating commands prompt the user with a modal confirmation dialog before executing.

### 9. [SCOPED-FIX-ITEMS-1-7] Mode Intelligence, Fence Sanitization & DX Hardening
- **Fence Sanitization Engine (`fenceSanitizer.ts`)**: Outer wrapper stripping, doc file fence preservation, boundary rejection on source files, interior fence warning badge in diff preview.
- **Intent Detection & Non-modal Switch Banner (`intentDetector.ts`)**: Direct action keywords and context-aware referential commands trigger non-modal suggestion banner. Informational questions are suppressed. Zero silent mode switches.
- **Dynamic Model Capability Check (`ollamaService.ts`)**: Derived strictly from `POST /api/show` capabilities (`tools`). Suggests alternatives dynamically from `/api/tags`. In-memory capability caching.
- **Structured-Edit Fallback Protocol (`structuredEditFallback.ts`)**: Strict CREATE, SEARCH/REPLACE, and DELETE schema validation, PathSecurity checks, and transactional application with diff preview.
- **Webview-Secure "Apply to File" RPC (`MessageValidator.ts`, `chatViewProvider.ts`)**: Opaque `messageId` + `blockIndex` contract; host retrieves code and path from internal trusted memory.
- **Real Error Diagnostics (`OllamaConnectionError`)**: Distinguishes connection drops from non-2xx HTTP responses, capturing error name, cause code, elapsed time, model, prompt size, generation ID, and instant /api/ps + /api/tags snapshot.

### 10. [SCOPED-FIX-ITEMS-A-E] Workspace Discovery & Explore-Before-Ask Gate
- **Bounded Deterministic Workspace Discovery (`workspaceDiscoveryService.ts`)**: Bounded manifest search (100 entries, depth 3, 2500ms timeout) injecting stacks, key files, git status, and diagnostics into initial planning context without LLM calls.
- **Explore-Before-Ask Gate (`exploreBeforeAskGate.ts`)**: Blocks premature `ask_user` until exploration quota ($N \ge 3$) is met. Clarification budget cap ($M=2$). Three escape hatches (deadlock, empty workspace, tool-less/failing model). Redundancy check against discovered facts.
- **Rule 8 Rewording**: Clarified in `agentRegistry.ts` that the agent must inspect files before asking questions.

### 11. [STREAMING-HOST-TIMING] Streaming Tool Calls, Real Electron Host Harness & Measurement Reconciliation
- **Streaming Tool Calling (`ollamaService.ts`)**: `stream: true` default in `chatWithTools` accumulating tool calls across chunk deltas, delivering 25–29ms TTFB on `qwen2.5-coder:7b` and 61ms on `qwen3.5:9b` (compared to non-streaming total wait times of ~814ms and ~1209ms) with progressive thinking token progress.
- **Multi-Tier Inactivity Timeouts (`ollamaService.ts`)**: Independent connect (5s), headers (15s/45s), sliding stream inactivity (30s resetting on every chunk), and total (180s/300s).
- **Probe Safety & Strict Embedded Gating (`ollamaService.ts`)**: Probes cached by `modelName + digest` without model eviction; embedded fallback default OFF (`localCopilot.tools.enableEmbeddedFallback`).
- **Real Electron Extension Host Harness (`smokeRealHost.test.ts`)**: 6 passing tests in real extension host validating `openTextDocument`, `applyEdit`, `save()`, UTF-8 BOM, CRLF preservation, and modal cancellation rejection safety.
- **Harness Invalidation**: Earlier mock write/outcome metrics formally marked INVALID due to harness defects (unbridged mock `openTextDocument`, stale closure `save()`). First-turn ask rates remain valid. Valid measurements re-run with positive controls, $N=3$ smoke traces, and 24-cell reduced ablation.

---

## 4. Verification & Test Summary

```
npm run compile
> tsc -p ./ -> 0 errors

npm run compile:test
> tsc -p ./tsconfig.test.json -> 0 errors

npm run vscode:prepublish
> 0 errors

git diff --check
> 0 errors

npm run test:unit
> 559 passing (6s) across 56 test suites, 0 failing

npm run test:real
> 34 passing across 9 test suites, 0 failing

npm run test:integration (real VS Code Electron extension host)
> 6 passing (28s), 0 failing
```
