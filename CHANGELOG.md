# Changelog

All notable changes to the `local-copilot-chat` extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] - 2026-11-08

### Security & Hardening - Final Fix Cycle: Queueing/Timeouts, User-Scoped Fallback & Data-Driven Router
- **Progressive Waiting & Queueing State (`chatViewProvider.ts`)**:
  - Added visible UI notification state `"Waiting for Ollama (request may be queued or model loading)"` when response headers have not arrived after 10 seconds.
  - Displays dynamic elapsed seconds counter and actionable `"Cancel"` (`stopGeneration`) and `"Keep waiting"` controls.
  - Automatically clears as soon as the first stream chunk arrives, or upon completion/error.
- **Dedicated Hard First-Byte Timeout & Migration (`configurationService.ts`, `ollamaService.ts`, `package.json`)**:
  - Dedicated setting: `localCopilot.timeouts.headersTimeoutMs` (default `45000` ms, bounds 1,000ms - 300,000ms).
  - Empirical policy derivation: cold load of largest installed model on RTX 3070 (~9.6s for 9B) + prompt evaluation of ~2,000 tokens (~5.1s at ~390 tok/s) + queue serialization allowance (~30s) = ~44.7s -> 45s default.
  - Post-first-byte timer policy: once headers/first chunk arrive, the headers timer is cleared; only the sliding inactivity timer (`idleStreamTimeout`, default 30s) and total turn timer (`totalGenerationTimeout`, default 300s) apply.
  - Backward compatibility: automatically reads legacy `localCopilot.headersTimeout` if present.
- **User-Scoped Fallback Security & Modal Confirmation (`package.json`, `configurationService.ts`, `chatViewProvider.ts`, `messageValidator.ts`)**:
  - Configured `localCopilot.tools.enableEmbeddedFallback` with `"scope": "application"` in `package.json`, preventing workspace-level override in untrusted repositories.
  - `ConfigurationService.enableEmbeddedToolCallFallback` reads `inspect().globalValue`, actively ignoring workspace settings.
  - Extension requires explicit host-side modal confirmation dialog (`vscode.window.showWarningMessage(..., { modal: true })`) before writing the setting.
  - Neutralized potential injection in model names and banners via `ChatViewProvider.escapeHtml()`.
  - `MessageValidator` enforces strict object keys on `enableEmbeddedFallback` RPC, rejecting extraneous fields.
- **Router Heuristic Documentation & Embedding-Only Exclusion (`modelRouter.ts`)**:
  - Documented all scoring weights in `ROUTER_HEURISTIC_WEIGHTS` with name, value, and expert rationale (no claims of being empirically measured transfer functions).
  - Embedding-only models declaring capabilities `['embedding']` without `['completion']` (e.g. `nomic-embed-text:latest`) are excluded from chat and agent candidate pools.
  - Auto in Agent mode strictly excludes any model that failed the behavioral probe.
  - Preserves user's pinned model when candidates have equal data.

### Security & Hardening - Unified Single-Function Tool Call Extraction & Timeout Defaults
- **Unified Tool Call Extraction (`ollamaService.ts`)**:
  - Replaced all ad-hoc content parsing regex paths (`extractToolCallsFromContent`, `offeredToolNames` content sweeps, embedded fallback heuristic sweeps) with a single, strictly-gated extractor function `extractEmbeddedToolCall`.
  - **Strict Security Pre-conditions**: Native `tool_calls` must be empty; user setting `localCopilot.tools.enableEmbeddedFallback` must be explicitly `true` (default `false`); model must be flagged as embedded-capable via user-selected model probe (never during Auto mode); text outside `<think>` blocks and outside blockquotes/echoes.
  - **Single Root Object Invariant**: The whole assistant message (after trimming) must be *exactly one JSON object* or *one fenced JSON block that is the entire message*. Any message containing JSON among prose is rejected immediately and never executed.
  - Arguments are validated against role allowlists and schema before dispatch.
- **ModelRouter Data-Driven Selection (`modelRouter.ts`)**:
  - Removed all hardcoded model names from routing logic, ranking, messages, and test names.
  - Ranks candidates strictly by empirical data: `/api/show` capabilities (`tools`, `thinking`, `insert`), cached behavioral probe results (native vs content calls), and calibrated `ModelProfile` benchmarks (tool reliability, category strength, TPS).
  - Preserves user's pinned model when no empirical data differentiates candidates.
- **Timeout Defaults Harmonization (`ollamaService.ts`, `configurationService.ts`)**:
  - Unified on single canonical total-timeout setting key: `localCopilot.totalGenerationTimeout` (default 300,000ms, bounds 30,000ms to 900,000ms).
  - Connect timeout for chat streaming defaults to `undefined` (socket level) so it does not abort cold model loads.
  - Headers / first-byte timeout defaults to 45,000ms (bounds 1,000ms to 300,000ms) to tolerate cold loads (measured: 4.0s for 7B, 7.0s for 8B, 9.6s for 9B on RTX 3070) plus prompt evaluations.
  - Inactivity (idle stream) timeout defaults to 30,000ms (resets on every token received).
- **Verbatim User Prompt Replay ($N=5$ per cell on `qwen3.5:9b`)**:
  - Replayed verbatim prompts (`"angular is partially implemented"` and `"Missing pieces..."`) on synthetic fullstack fixture.
  - Fixed first-turn-ask detector: triggers on `ask_user` tool call OR turn 1 ending with no tool calls whose content contains a question or clarification request. Tested against historical traces ("I need clarification", "Please provide more details").
  - Fixed harness double-counting bug where `questionsAllowed` was incremented in both `onToolEnd` and `onAskUser`.
  - Empirical outcome: First-turn ask rate was 0/10 in Baseline vs 0/10 in Hardened (Fisher exact $p = 1.000$, NO MEASURABLE EFFECT). Fences removed in Prompt 2 was 3/5 in Baseline vs 2/5 in Hardened (Fisher exact $p = 1.000$, INCONCLUSIVE). Full end-to-end clean compilation was 0/10 in both conditions (Fisher exact $p = 1.000$, NO MEASURABLE EFFECT).
- **Hardware & Environment Ground Truth**:
  - Physical GPU: NVIDIA GeForce RTX 3070 (8,192 MB VRAM), Driver 617.14 (confirmed via raw `nvidia-smi`).
  - DeepSeek-R1 8B raw `/api/show` details: family `qwen3` (`8.2B`, `Q4_K_M`), capabilities `["tools", "thinking", "completion"]`.
  - Scripted gate verification in test suite marked explicitly as a scripted mock demonstration.

### Added - Scoped Fix: Workspace Discovery, Explore-Before-Ask Gate & Agent Hardening
- **Bounded Deterministic Workspace Discovery Pre-Step (`workspaceDiscoveryService.ts`)**:
  - Plain TypeScript execution before the first planning turn without LLM calls.
  - Bounded by max entries (100), max depth (3), and execution timeout (2500ms) within `PathSecurity` containment.
  - Character budget derived dynamically from `numCtx` (1500 to 8000 characters).
  - Detects frameworks from project manifests (`*.csproj`, `*.sln` -> ASP.NET Core; `package.json` -> Angular, React, Vue, Express, TypeScript; `pom.xml`, `requirements.txt`, `Cargo.toml`, `go.mod`).
  - Reports key entry files present/missing (`Program.cs`, `main.ts`, etc.) and read-only `git status --short --branch` via `GitExecutionIsolator`.
  - Excludes secrets (`.env*`, `id_rsa`, `.pem`, `.key`), binary files, and heavy directories (`node_modules`, `bin`, `obj`, `dist`, `.vs`).
  - Untrusted data sanitization: neutralizes control characters, forged delimiters (`</untrusted_workspace_discovery>` -> `[neutralized_tag]`), and prompt injections (`ignore previous instructions` -> `[neutralized_injection]`).
  - Delivers bounded discovery excerpt to sub-agents during delegation.
- **Unified Explore-Before-Ask Gate & Clarification Budget (`exploreBeforeAskGate.ts`)**:
  - Single shared helper used by `SwarmOrchestrator`, `AutonomousAgent`, and sub-agents.
  - Gates `ask_user` calls until the agent executes at least $N$ distinct successful read-only exploration calls (default: 3).
  - Counts only distinct tool+target pairs (`list_dir`, `view_file_range`, `search_workspace`, `semantic_search`); repeated calls to the same path do not satisfy the gate.
  - Three escape hatches preventing deadlocks:
    1. Deadlock defense: allows question through after 2 task rejections.
    2. Empty workspace: allows early clarification immediately when discovery found 0 relevant files.
    3. Tool-less/failing models: allows clarification if the model lacks tool capabilities or encounters 3 consecutive tool failures.
  - Advisory redundancy check: questions asking about facts already present in discovery data (e.g. backend/frontend frameworks) are rejected at most once with explanatory guidance, then allowed.
  - Clarification question budget cap: limits clarification questions to a configurable maximum per task session (default: 2).
  - All decisions and rejections are logged to the Output Channel with generation IDs.
- **Statement vs Task & Action/Evidence Enforcement**:
  - Reworded Rule 8 in `OrchestratorAgent` and `AutonomousAgent` system prompts: instructs the agent to inspect files first and only ask about decisions the workspace cannot answer.
  - Added prompt directive: if the user input is a status statement rather than a direct task, inspect the workspace, report findings, and propose next steps instead of asking what the sentence means.
  - Retry logic: planning turns that terminate with only a clarification request while relevant files exist receive exactly one retry directive to inspect first, preventing infinite loops.
- **New Configuration Settings**:
  - `localCopilot.agent.minExplorationBeforeAsk` (default: `3`, range: `0` to `10`)
  - `localCopilot.agent.maxClarificationQuestionsPerTask` (default: `2`, range: `0` to `10`)
  - `localCopilot.agent.enableWorkspaceDiscoveryPreStep` (default: `true`)

### Added - Scoped Fix: Mode Intelligence, Fence Sanitization & DX Hardening
- **File-Type Aware Fence Sanitizer (`fenceSanitizer.ts`)**:
  - Strips outer ```` ```lang ```` fence wrapper and conversational prose while preserving interior lines, line endings (CRLF/LF), and BOM.
  - File-type aware: preserves code fences in `.md`, `.mdx`, `.rst`, and `.txt` files; enforces hard rejection on source/config files (`.cs`, `.ts`, `.py`, `.json`, etc.) if fence lines remain at the start/end; flags interior fence lines with a reviewable warning in diff preview.
  - Guarded all write paths: `AgentToolService.createFile`, `AppGeneratorService.writeFile`, `CodeGenerationEngine`, and `ChatViewProvider._createFileInWorkspace`.
- **Deterministic Intent Detection (`intentDetector.ts`)**:
  - Detects action verbs ("implement", "fix", "create", "update the files", "scaffold") without making model calls.
  - Context-aware referential triggers ("implement those", "fix it", "do it") inspecting previous assistant recommendations.
  - Suppresses false positives for informational questions ("how do I fix this?", "explain this function").
  - Displays a non-modal suggestion banner: *"💡 This request looks like it needs file edits. Switch to Agent mode?"* with one-click switch action.
- **Dynamic Capability Check**:
  - Derived strictly from `POST /api/show` capabilities (`capabilities.includes('tools')`) without hardcoded model names.
  - Queries `GET /api/tags` to suggest alternative installed models declaring tool support.
  - In-memory capability caching with TTL and invalidation on model change.
- **Structured-Edit Fallback Protocol (`structuredEditFallback.ts`)**:
  - Strict schema supporting CREATE (`FILE: <path>\n```\n<content>\n````), SEARCH/REPLACE (`FILE: <path>\n<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE`), and DELETE (`DELETE_FILE: <path>`).
  - Rejects duplicate paths, ambiguous search matches, zero-match searches, sensitive targets, and paths outside workspace via `PathSecurity`.
  - Transactional application with diff preview and explicit approval via `CodeGenerationEngine`.
- **Webview-Secure "Apply to File" Button**:
  - In Chat Mode, code blocks offer an `[📝 Apply to file]` button.
  - Sends only an opaque `messageId` and `blockIndex`; extension host looks up path and code from internal memory transcript, preventing arbitrary path/content injection from webview.
- **Real Diagnostic Error Extraction (`OllamaConnectionError`)**:
  - Replaces generic "fetch failed" with `error.name`, `error.cause?.code` (e.g. `ECONNREFUSED`, `ETIMEDOUT`), elapsed time, model, prompt size, and generation ID.
  - Distinguishes "no response received" from HTTP non-2xx errors, capturing sanitized/redacted HTTP response bodies.
  - Captures instant diagnostic snapshot of `/api/ps` and `/api/tags`.
- **New Configuration Settings**:
  - `localCopilot.agent.enableStructuredEditFallback` (default: `true`)
  - `localCopilot.agent.suggestAgentModeOnEditIntent` (default: `true`)

### Added - Phase 10: Advanced Orchestration & Swarm Intelligence
- **Hardware Capacity Manager (`HardwareCapacityManager`)**: Serialized FIFO LLM inference turn queue guaranteeing single-model GPU residency under 8 GB VRAM budget while allowing concurrent non-LLM background tool execution.
- **Whiteboard Coordinator v3 (`WhiteboardCoordinator`)**: Subtask lifecycle state machine with dependency tracking, atomic checkpoints, state rollback, and disk persistence to `.vscode/local-copilot/whiteboard-v3.json`.
- **Sub-Agent Task Pool (`SubagentTaskPool`)**: Prioritized asynchronous background tool task pool with concurrency cap (default 2) and AbortSignal cancellation propagation.
- **File-Level Lease Manager (`FileLeaseManager`)**: Shared read leases, exclusive write leases, automatic 30s TTL expiry, and canonical alphabetical sorting for deadlock-free multi-file transactional acquisition.
- **Typed Agent Contracts (`TypedAgentContracts`)**: Strictly typed I/O schemas and runtime validation for Architect, Developer, Tester, Reviewer, and SecurityAuditor roles.
- **Sub-Agent Delegation Protocol (`SubagentDelegationProtocol`)**: Task delegation with 25s timeout enforcement, automatic retries with corrective error prompts, and delegation audit history.
- **Consensus Verification Engine (`ConsensusVerifier`)**: Unanimous multi-agent consensus requirement combining deterministic pre-checks, Tester execution, Reviewer quality review, and Security Auditor approval.
- **Adversarial Prompt Defense (`AdversarialPromptDefense`)**: Untrusted data feed quarantine neutralizing instruction overrides, role-spoofing tags (`<system>`), jailbreak markers, and credential leaks.
- **Multi-Strategy Code Fallbacks (`MultiStrategyCodeGenerator`)**: 3-tier fallback code patching (exact `str_replace` -> normalized whitespace/CRLF -> anchor-based block replacement) with SHA-256 pre/post image verification.

### Added - Phase 9: Agent Intelligence & Coding Quality
- **30-Task Benchmark Corpus (`benchmarkTaskCorpus`)**: Standardized 30-task benchmark suite (10 code repair, 8 feature generation, 6 refactor, 6 tool use) and automated run comparator.
- **Tolerant JSON Parser (`TolerantJsonParser`)**: 4-stage tolerant repair pipeline recovering markdown code fences, trailing commas, unquoted keys, single quotes, and truncated bracket balance.
- **Context Compaction Service (`ContextCompactionService`)**: Structured conversation compaction generating `<CONTEXT_SUMMARY>` preserving goals, referenced files, operations, and diagnostics.
- **Incremental Repository Map (`RepositoryMapService`)**: In-process AST and symbol degree-centrality ranking with `.vscode/local-copilot/repo-map.json` atomic disk caching.
- **Context Budget Manager (`ContextBudgetManager`)**: Hard token allocations for 8k window and `<untrusted_content>` XML quarantine.
- **Structured Plan Schema (`PlanManager`)**: Fast-path trivial query router, versioned `PlanSchemaV1` schema, step limit enforcement, and backward-only acyclic dependencies.
- **Pre-Edit Impact Analysis (`ImpactAnalysisService`)**: Symbol caller computation, test discovery, and coordinated multi-file edit set generation.
- **Iterative Code Repair (`CodeRepairEngine`)**: Patch hashing, oscillation detection, and deterministic test-weakening prevention rejecting removal of assertions or insertion of `.skip`/`xit`.
- **Independent Reviewer Pipeline (`IndependentReviewer`)**: Deterministic pre-checks (compiler diagnostics, sensitive targets, secret leaks, test weakening) preceding LLM evaluation, and out-of-bounds line pruning.

### Added - Phase 8: Production Readiness & Disaster Recovery
- **Real Integration Tier**: 7 test suites validating real process spawning (`node`, `git`, `npm test`), symlink escapes, junction blocks, socket timeouts, and atomic file concurrency.
- **Live Ollama Verification**: Streaming tokens from real `qwen2.5-coder:7b`, VRAM residency tracking via `/api/ps`, and complete VRAM release verification via `keep_alive: 0`.
- **Disaster Recovery Backup Drill**: Verified baseline backups created and tested for recovery.

### Added - Phase 6 & 7: Autonomous Capabilities & Hardening
- **Autonomous Debugging (`/fix`)**: Diagnostic error parser (Node/V8, TypeScript, Python tracebacks), workspace culprit isolation, and surgical patch verification.
- **Path Security Containment (`PathSecurity`)**: Centralized boundary validation enforcing path traversal prevention, symlink/junction canonicalization, null-byte rejection, and UNC path blocks.
- **Transactional Code Generation (`CodeGenerationEngine`)**: Multi-file atomic writes with pre-flight byte snapshots, post-verification check, and automatic rollback.
