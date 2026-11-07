# Changelog

All notable changes to the `local-copilot-chat` extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] - 2026-11-07

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
