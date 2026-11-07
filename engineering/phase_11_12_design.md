# Phase 11 & 12 Technical Architecture Design
## Claude Code-Level Developer Experience, Model Intelligence & Optimization

**Project:** `local-copilot-chat`  
**Repository:** `C:\Projects\local-copilot-chat`  
**Target Hardware:** NVIDIA RTX 3070 (8 GB VRAM), 32 GB system RAM, Windows 11  
**Execution Mode:** STAGE A (Read-Only Architecture & Technical Design)  
**Baseline Git Commit:** `b9c23c942b9e027ec5303a048b9099ba6e923d9d`  

---

## Precondition Verification (Stage 0 Confirmation)

In compliance with Stage 0 requirements, the completion reports and working tree have been inspected:

| Subsystem / Policy | Current Status | Code / Report Evidence |
|---|---|---|
| **Phase 8 Report** | Verified Complete | [`engineering/phase_8_completion_report.md#L30-L52`](file:///c:/Projects/local-copilot-chat/engineering/phase_8_completion_report.md#L30-L52) |
| **Phase 9 Report** | Verified Complete | [`engineering/phase_9_completion_report.md#L30-L60`](file:///c:/Projects/local-copilot-chat/engineering/phase_9_completion_report.md#L30-L60) |
| **Phase 10 Report** | Verified Complete | [`engineering/phase_10_completion_report.md#L30-L60`](file:///c:/Projects/local-copilot-chat/engineering/phase_10_completion_report.md#L30-L60) |
| **Benchmark Harness (8.7/9.0)** | Active & Verified | [`src/services/evaluationService.ts#L60-L130`](file:///c:/Projects/local-copilot-chat/src/services/evaluationService.ts#L60-L130), [`src/services/benchmarkTaskCorpus.ts#L1-L30`](file:///c:/Projects/local-copilot-chat/src/services/benchmarkTaskCorpus.ts#L1-L30) (30 tasks) |
| **Real Integration Tier** | Active & Passing | [`test/real-integration/`](file:///c:/Projects/local-copilot-chat/test/real-integration/) (7 test suites, 23 offline passing, 3 pending offline / 26 online) |
| **Sensitive Target Policy** | Enforced | [`src/services/pathSecurity.ts#L45-L77`](file:///c:/Projects/local-copilot-chat/src/services/pathSecurity.ts#L45-L77) |
| **Transactional Patch Engine** | Active & Journaled | [`src/services/codeGenerationEngine.ts#L48-L150`](file:///c:/Projects/local-copilot-chat/src/services/codeGenerationEngine.ts#L48-L150) |
| **Model Lifecycle Manager** | Active & Eviction-Safe | [`src/services/modelLifecycleManager.ts#L14-L60`](file:///c:/Projects/local-copilot-chat/src/services/modelLifecycleManager.ts#L14-L60), [`src/services/hardwareCapacityManager.ts#L25-L65`](file:///c:/Projects/local-copilot-chat/src/services/hardwareCapacityManager.ts#L25-L65) |
| **Atomic File Writer** | Active & Mutex-Guarded | [`src/services/atomicFileWriter.ts#L30-L65`](file:///c:/Projects/local-copilot-chat/src/services/atomicFileWriter.ts#L30-L65) |

**Stage 0 Verdict:** All critical infrastructure components and security gates are intact and verified. No preconditions are missing or broken.

---

# SECTION 1: PHASE 11 — CLAUDE CODE-LEVEL DEVELOPER EXPERIENCE

---

### Deliverable 11.0: Baseline & Session Engine Extraction

#### 1. Current-State Findings
- The UI logic in [`src/providers/chatViewProvider.ts#L480-L650`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L480-L650) tightly couples webview message dispatching (`_handleSendMessage`), streaming token consumption, slash command routing, tool approvals, and persistence.
- Duplication exists across slash command handling in `ChatViewProvider` ([`src/providers/chatViewProvider.ts#L800-L950`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L800-L950)) and `SwarmOrchestrator` ([`src/services/swarmOrchestrator.ts#L400-L550`](file:///c:/Projects/local-copilot-chat/src/services/swarmOrchestrator.ts#L400-L550)), particularly regarding tool-call parsing, context assembly, and file diff generation.
- Historical transcripts are stored as simple message arrays in `.vscode/local-copilot/chat_history.json` ([`src/providers/chatViewProvider.ts#L140-L175`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L140-L175)), which lacks structured metadata (active plan, subtask board, tool invocation IDs, approval audit entries).

#### 2. Risks & Failure Modes
- **Refactoring Regressions**: Extracting a headless `SessionEngine` could accidentally break existing webview streaming hooks, thought token encapsulation, or slash command cancellation.
- **Race Conditions**: Shared state between concurrent front-ends (webview and interactive terminal) could lead to unsynchronized generation turns if the single-flight mutex is bypassed.

#### 3. Proposed Design
- Introduce `SessionEngine` (`src/services/sessionEngine.ts`) as a decoupled headless state machine:
  - Manages generation lifecycle, abort controllers, context building, model inference calls via `HardwareCapacityManager`, tool execution via `AgentToolService`, and approval callbacks.
  - Front-ends (`ChatViewProvider` and `AgentTerminalProvider`) become thin adapters consuming standard `SessionEngineEvent` streams (`token`, `thought`, `tool_start`, `tool_end`, `approval_request`, `stream_end`).
- **New Settings**:
  - `localCopilot.sessionEngine.enabled`: `boolean` (default: `true`).

#### 4. Test Plan
- Unit tests: `test/unit/sessionEngine.test.ts` (mocked LLM, verifying identical event dispatching to simulated webview and terminal listeners).
- Benchmark: 30-task corpus execution baseline comparison before and after extraction.

#### 5. Acceptance Criteria
- Zero regression in 30-task benchmark pass rate ($TCR \ge 30/30$).
- Webview and headless test harnesses execute identical workflows through `SessionEngine`.

#### 6. Rollback Plan
- Setting `localCopilot.sessionEngine.enabled = false` falls back directly to legacy `ChatViewProvider` execution path.

#### 7. Open Questions
- Should session transcripts retain `<think>` tokens when persisted, or continue strict suppression? *(Recommendation: suppress from prompt history, retain in debug transcript).*

---

### Deliverable 11.1: Interactive Terminal (Agent Pseudoterminal)

#### 1. Current-State Findings
- The extension currently interacts with the VS Code terminal strictly through `vscode.window.createTerminal().sendText(...)` in [`src/providers/chatViewProvider.ts#L425-L440`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L425-L440).
- There is no extension-owned interactive CLI or Pseudoterminal. All interaction is confined to the Webview.

#### 2. Risks & Failure Modes
- **Terminal Escape Injection**: Malicious file contents or adversarial model outputs containing ANSI escape sequences (CSI, OSC 52, DEC) could manipulate terminal state, clear screen, rewrite prompts, or copy arbitrary data into the host clipboard.
- **Approval Prompt Spoofing**: A model could emit text mimicking an approval prompt (`"Approve modification to .env? [y/N]"`), tricking the developer into pressing `y`.
- **ConPTY Windows Artifacts**: Windows ConPTY handles carriage returns and Unicode character widths differently than Unix PTYs; line-wrapping bugs can corrupt multiline displays.

#### 3. Proposed Design
- Implement `AgentTerminalProvider` (`src/services/agentTerminalProvider.ts`) implementing `vscode.Pseudoterminal`:
  - Does NOT spawn a child shell process (`cmd.exe` or `powershell.exe`). All commands execute solely through the classified `AgentToolService` pipeline.
  - **Escape Sequence Sanitization**:
    - Pre-processes all model, tool, and file text with `TerminalSanitizer.sanitize()`, stripping all CSI (`\x1b\[...`), OSC (`\x1b\]...`), and unprintable control characters.
    - Only extension chrome (prompt labels, status indicators, border rules) may emit ANSI styling sequences.
  - **Spoofing Defense**:
    - Approval prompts are rendered with inverted color status banners and dedicated input interceptors; model output cannot generate interactive input prompts.
  - **Key Bindings**:
    - `Ctrl+C`: First press aborts active generation (triggers `SessionEngine.abort()`); second press exits session.
    - Up/Down: History traversal across persisted user command history.
- **New Settings**:
  - `localCopilot.terminal.enabled`: `boolean` (default: `true`).
  - `localCopilot.terminal.fontSize`: `number` (default: `13`).

#### 4. Test Plan
- Unit test: `test/unit/terminalSanitizer.test.ts` with adversarial escape sequence corpus (OSC 52, cursor repositioning, prompt spoofing).
- Real integration test: `test/real-integration/terminalLifecycle.test.ts` verifying Pseudoterminal open, input, generation cancellation, and exit.

#### 5. Acceptance Criteria
- Malicious model outputs containing terminal escape payloads are neutralized 100%.
- Terminal input stream cancellation cleanly aborts active Ollama inference in $< 500\text{ms}$.

#### 6. Rollback Plan
- Disabling `localCopilot.terminal.enabled` hides the terminal command and prevents Pseudoterminal registration.

#### 7. Open Questions
- Should the agent terminal launch automatically on IDE startup? *(Recommendation: No, launch only via explicit command `Local Copilot: Open Agent Terminal`).*

---

### Deliverable 11.2: Persistent Sessions & Multi-Window Safety

#### 1. Current-State Findings
- Chat history persistence is currently handled by `ChatViewProvider._saveChatHistory` to `.vscode/local-copilot/chat_history.json` ([`src/providers/chatViewProvider.ts#L140-L175`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L140-L175)).
- Stored format is unversioned and cannot store multi-session forks, token accounting, or approval audit records.

#### 2. Risks & Failure Modes
- **Concurrent Window Corruption**: Two VS Code windows open on the same multi-root workspace writing to the same session file will cause clobbering or write collisions.
- **Attacker-Supplied Session Tampering**: Restored transcripts could be edited by an attacker to contain auto-approved actions.

#### 3. Proposed Design
- Implement `SessionPersistenceService` (`src/services/sessionPersistenceService.ts`):
  - **Session Schema v2**:
    ```typescript
    interface SessionRecordV2 {
      schemaVersion: 2;
      sessionId: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      model: string;
      status: 'idle' | 'generating' | 'interrupted';
      transcript: ChatMessage[];
      activePlan?: PlanSchemaV1;
      compactionSummaries: string[];
      approvalAudit: ApprovalAuditRecord[];
      tokenUsage: { prompt: number; completion: number; total: number };
    }
    ```
  - **Storage Location**: `.vscode/local-copilot/sessions/<sessionId>.json` written atomically via `AtomicFileWriter`.
  - **Crash Recovery**: Sessions left in `'generating'` state are rehydrated as `'interrupted'`. Restored transcripts are treated strictly as read-only historical *data*; pending approvals are voided.
  - **Multi-Window Locking**: Uses PID-stamped lockfiles (`.vscode/local-copilot/sessions/<sessionId>.lock`) with stale lock timeout (10s).
  - **Auto-Migration**: Automatically converts legacy `chat_history.json` into Session Schema v2 on first boot.
  - **Slash Commands**: `/sessions`, `/resume`, `/fork`, `/rename`, `/export`, `/clear`.
- **New Settings**:
  - `localCopilot.sessions.maxRetained`: `number` (default: `20`).

#### 4. Test Plan
- Unit test: `test/unit/sessionPersistence.test.ts` (round-trip save/load, legacy v1 migration, crash recovery, secret redaction, lock contention).

#### 5. Acceptance Criteria
- Sessions survive crash/reload with zero data loss and invalid approvals neutralized.
- Legacy `chat_history.json` is cleanly converted to Session Schema v2 without user prompt.

#### 6. Rollback Plan
- Automatic fallback reads `chat_history.json` if session folder is absent.

#### 7. Open Questions
- Should export support HTML format or only Markdown/JSON? *(Recommendation: Markdown and JSON only).*

---

### Deliverable 11.3: Intelligent Tiered Context Compaction & Fidelity Harness

#### 1. Current-State Findings
- Phase 9.7 introduced `ContextCompactionService` ([`src/services/contextCompactionService.ts#L35-L95`](file:///c:/Projects/local-copilot-chat/src/services/contextCompactionService.ts#L35-L95)), which formats a single `<CONTEXT_SUMMARY>` block.
- It operates with fixed token thresholds and lacks structured tiered compaction (bulky tool output pruning vs LLM summarization vs hard truncation).

#### 2. Risks & Failure Modes
- **Lost-in-the-Middle Loss of Key Facts**: Naive summarization can drop user constraints (e.g. "do not edit auth.ts") or architectural decisions made early in the session.
- **Compaction Mid-Tool-Call**: Running compaction while a tool call is awaiting execution breaks argument references.

#### 3. Proposed Design
- Implement Tiered Compaction Pipeline in `ContextCompactionService`:
  - **Tier 1 (Deterministic Output Pruning)**: Replaces large file dumps (>1,000 chars) with pointer references `[File Content Omitted: re-request via readFile("path")]`.
  - **Tier 2 (Duplicate Deduplication)**: Consolidates repeated build diagnostic errors and repetitive tool outputs into single summarized tallies.
  - **Tier 3 (Structured LLM Summarization)**: Summarizes older dialog turns into a structured XML summary with sections: `<goals>`, `<constraints>`, `<files_modified>`, `<decisions>`, `<open_tasks>`.
  - **Tier 4 (Hard Truncation)**: Truncates oldest non-pinned messages only if Tiers 1-3 do not meet the target ceiling.
  - **Pinned Content (Never Compacted)**: System prompt, standing user instructions, active `PlanSchemaV1`, pending approvals, and the last $N$ interactive turns (default 4).
- **Fidelity Evaluation Harness**:
  - Seeded-fact benchmark test: Inserts 10 specific constraints/facts into a 20-turn dialog, forces compaction, and verifies retrieval accuracy against an uncompacted baseline.
- **New Commands**:
  - `/context`: Displays token breakdown by category (System, RepoMap, Plan, History, Bulky Output) and estimated compaction savings.
  - `/compact [instructions]`: Manually triggers targeted compaction.
- **New Settings**:
  - `localCopilot.context.compactionTriggerThreshold`: `number` (default: `0.75` of `numCtx`).

#### 4. Test Plan
- Unit test: `test/unit/contextCompactionTiered.test.ts` (seeded-fact retention test, pinned content survival, zero mid-tool-call compaction).

#### 5. Acceptance Criteria
- Pinned content survives 100% of compaction cycles.
- Seeded-fact retention rate $\ge 90\%$ after Tier 1–3 compaction.

#### 6. Rollback Plan
- Disabling compaction reverts to standard FIFO truncation.

#### 7. Open Questions
- When `numCtx` is small (4096), should Tier 3 LLM summarization be skipped in favor of Tier 1+2 to save tokens? *(Recommendation: Yes, skip Tier 3 if available budget $< 1000$ tokens).*

---

### Deliverable 11.4: Read-Only Plan Mode & Strict Dispatcher Enforcement

#### 1. Current-State Findings
- Phase 9.3 introduced `PlanManager` ([`src/services/planSchema.ts#L30-L100`](file:///c:/Projects/local-copilot-chat/src/services/planSchema.ts#L30-L100)) with schema validation and trivial query detection.
- However, there is no distinct global "Plan Mode" where write/execute tools are stripped from the tool registry at the code level.

#### 2. Risks & Failure Modes
- **Tool Dispatcher Bypass**: If plan mode is only enforced via system prompts, local 7B models frequently attempt to invoke `patchFile` or `execute_command` anyway.
- **Mode Escape via Injection**: Adversarial text in workspace files could output fake mode-switch instructions.

#### 3. Proposed Design
- Implement `PlanModeController` (`src/services/planModeController.ts`):
  - When Plan Mode is active:
    - Tool allowlist in `AgentToolService` is strictly filtered *in code*: only read-only tools (`readFile`, `listDir`, `findCallers`, `searchSymbols`, `getGitDiff`) are registered with Ollama. Destructive tools (`patchFile`, `createFile`, `deleteFile`, `execute_command`) are completely omitted.
    - If a model hallucinates a call to a write tool, the dispatcher immediately rejects it with: `"Error: Write operations are disabled while in Plan Mode. Output a plan or ask the user to approve execution."`
  - **User-Only Transition Gate**:
    - Only explicit user interaction (clicking `[Approve Plan & Execute]`, `/approve-plan`, or pressing terminal shortcut) can exit Plan Mode. The LLM cannot transition itself.
  - Status bar updates to display `$(checklist) Plan Mode`.
- **New Settings**:
  - `localCopilot.planMode.requireApprovalBeforeExecution`: `boolean` (default: `true`).

#### 4. Test Plan
- Unit test: `test/unit/planMode.test.ts` (asserts write tools absent from registry in plan mode, fake model cannot break out of plan mode, approval round-trip).

#### 5. Acceptance Criteria
- 100% of write tool attempts are blocked in code while in Plan Mode.
- Plan mode transitions only upon genuine user action.

#### 6. Rollback Plan
- Plan mode can be toggled off via `/plan off` or setting default to false.

#### 7. Open Questions
- Should plan mode allow read-only terminal commands like `npm test`? *(Recommendation: No, terminal execution remains Tier 2/3 and requires execution mode).*

---

### Deliverable 11.5: Content-Addressed Local Checkpoints & File Rewind

#### 1. Current-State Findings
- Phase 8.5 introduced `tx-journal.json` in `CodeGenerationEngine` ([`src/services/codeGenerationEngine.ts#L48-L120`](file:///c:/Projects/local-copilot-chat/src/services/codeGenerationEngine.ts#L48-L120)), which stores base64 pre-flight byte snapshots for the active transaction.
- It does not maintain an indexed content-addressed history of multi-turn checkpoints that the user can inspect or rewind.

#### 2. Risks & Failure Modes
- **Clobbering User Edits on Rewind**: If a user manually edited a file in VS Code after a checkpoint was taken, an unconditional rewind would overwrite their manual work.
- **Git State Confusion**: Users might assume `/rewind` reverts Git commits or undoes terminal command side-effects (e.g. `npm install`).

#### 3. Proposed Design
- Implement `CheckpointManager` (`src/services/checkpointManager.ts`):
  - **Storage Format**: Content-addressed blob store in `.vscode/local-copilot/checkpoints/`:
    - Blobs stored by SHA-256 hash: `.vscode/local-copilot/checkpoints/blobs/<sha256>`.
    - Manifest index `.vscode/local-copilot/checkpoints/index.json` maps checkpoint ID to timestamp, description, user prompt, and file manifest `{ filePath: sha256 }`.
  - **Automatic Checkpointing**: Created before each agent turn or transactional edit set that modifies workspace files.
  - **Rewind Safety Check**:
    - Prior to rewinding a file, checks current disk hash and dirty editor buffers (`vscode.workspace.textDocuments.find(d => d.isDirty)`).
    - If current disk hash does not match either the checkpoint hash or the post-edit snapshot hash (meaning the user made independent manual edits), halts and prompts: `"File has unsaved or manual changes. Overwrite? [y/N]"`.
  - **Rewind is Undoable**: Executing a rewind creates a fresh "pre-rewind" checkpoint first.
  - **Explicit Caveat**: UI and docs clearly display: *"Checkpoints restore file content only. Terminal command side-effects (e.g. installs, builds) are not reversed."*
  - **Commands**: `/checkpoints`, `/diff-checkpoint [id]`, `/rewind [id]`.
- **New Settings**:
  - `localCopilot.checkpoints.maxRetained`: `number` (default: `15`).
  - `localCopilot.checkpoints.maxFileSizeKb`: `number` (default: `1024`).

#### 4. Test Plan
- Unit test: `test/unit/checkpointManager.test.ts` (blob deduplication, SHA-256 verification, user modification conflict detection, rewind round-trip).
- Real integration test: `test/real-integration/checkpointDisk.test.ts` on real filesystem with CRLF/LF preservation.

#### 5. Acceptance Criteria
- File content is 100% byte-identical after edit and rewind.
- Manual user changes made after checkpoint are never silently overwritten.

#### 6. Rollback Plan
- Pre-rewind checkpoint guarantees rewind itself can be reverted immediately.

#### 7. Open Questions
- Should untracked files created by the agent be deleted on rewind? *(Recommendation: Yes, delete created files after user confirmation, preserving backup in blob store).*

---

### Deliverable 11.6: Unified Approval Policy Engine & Grant Storage

#### 1. Current-State Findings
- Approval checks currently exist in multiple scattered locations: `AgentToolService.executeCommand` ([`src/services/agentToolService.ts#L480`](file:///c:/Projects/local-copilot-chat/src/services/agentToolService.ts#L480)), `SwarmOrchestrator.dispatchBaseTool` ([`src/services/swarmOrchestrator.ts#L680`](file:///c:/Projects/local-copilot-chat/src/services/swarmOrchestrator.ts#L680)), and `ChatViewProvider._handleRunCommand` ([`src/providers/chatViewProvider.ts#L425`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L425)).
- There is no unified approval grant memory or centralized audit trail.

#### 2. Risks & Failure Modes
- **Repo-Shipped Rule Exploitation**: A malicious repository could check in a configuration or rule file granting auto-approval to arbitrary shell commands.
- **Approval Replay & Queue Races**: Concurrently executing sub-agents could race to consume a single approval grant intended for a specific file.

#### 3. Proposed Design
- Implement `ApprovalPolicyEngine` (`src/services/approvalPolicyEngine.ts`):
  - **Approval Modes**:
    - `ask-always`: Prompt for every file write and every command.
    - `accept-edits-in-workspace`: Auto-approve non-sensitive workspace file edits; prompt for commands and sensitive targets.
    - `plan-only`: No write tools permitted.
    - `allowlisted-auto`: Auto-approve whitelisted commands and non-sensitive edits.
  - **Action-Bound Grants**:
    - Grants are cryptographically bound to the specific action hash: `SHA-256(toolName + normalizedCommand + normalizedPath + patchHash)`.
    - Grants cannot be replayed or transferred across sub-agents or tasks.
  - **Grant Storage Safety**:
    - Persistent grants are stored strictly in `vscode.ExtensionContext.globalState` (user-level storage), NEVER in workspace files or repo-committed files.
    - Tier 4 commands are fundamentally ungrantable under any mode or rule.
  - **Serialized Approval Queue**:
    - Serializes concurrent approval requests from parallel sub-agents; displays clear attribution (`[Agent: Tester | Task: Run Unit Tests]`).
  - **Commands**: `/approvals` (view audit log and active session grants).
- **New Settings**:
  - `localCopilot.approval.defaultMode`: `string` (default: `'accept-edits-in-workspace'`).
  - `localCopilot.approval.timeoutSeconds`: `number` (default: `60`).

#### 4. Test Plan
- Unit test: `test/unit/approvalPolicyEngine.test.ts` (action hash binding, deny rule precedence, Tier 4 ungrantable, repo rule file ignored, queue serialization).

#### 5. Acceptance Criteria
- Zero grant reuse across distinct actions.
- Malicious workspace-shipped approval config files are completely ignored.

#### 6. Rollback Plan
- Setting `localCopilot.approval.defaultMode = 'ask-always'` restores conservative per-action prompts.

#### 7. Open Questions
- Should session grants expire after 1 hour of inactivity? *(Recommendation: Yes, enforce 1-hour session grant TTL).*

---

### Deliverable 11.7: Git-Aware Development & Safety Invariants

#### 1. Current-State Findings
- Git execution is protected by `GitExecutionIsolator` ([`src/services/gitExecutionIsolator.ts#L15-L50`](file:///c:/Projects/local-copilot-chat/src/services/gitExecutionIsolator.ts#L15-L50)), enforcing `-c core.hooksPath=/dev/null` and `--no-ext-diff`.
- `ChatViewProvider` supports `/diff` and `/commit` ([`src/providers/chatViewProvider.ts#L800-L870`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L800-L870)), but lacks branch protection, uncommitted dirty tree safety guards, or conventional commit style detection from git log.

#### 2. Risks & Failure Modes
- **Attacking Main/Protected Branches**: Agent modifying code on `main` without checking for uncommitted user changes.
- **Prompt Injection via Git Metadata**: Adversary crafting malicious branch names (`feature/$(rm -rf)`) or commit messages with prompt injections.

#### 3. Proposed Design
- Implement `GitIntelligenceService` (`src/services/gitIntelligenceService.ts`):
  - Uses `GitExecutionIsolator` for all child process calls with `{ shell: false }`.
  - **Dirty Tree & Branch Safety**:
    - Before applying agent patches, checks `git status --porcelain`.
    - If uncommitted user modifications exist on target files, displays warning: `"File has uncommitted changes. Create checkpoint and proceed? [y/N]"`.
    - Protected branch guard: Warns if current branch is `main`, `master`, or `release/*`.
  - **Prohibited Operations (Strict Tier 4 / Prohibited)**:
    - The agent is blocked from executing: `git push`, `git push --force`, `git reset --hard`, `git clean -f`, `git rebase`, `git branch -D`, `git checkout -f`.
  - **Conventional Commit Generator (`/commit`)**:
    - Reads last 10 commit messages to infer repo style (e.g. `feat:`, `fix(core):`).
    - Formats staged diff and pre-populates commit message for human review. Never auto-commits without user click/approval.
  - **Git Metadata Sanitization**:
    - Sanitizes branch names, commit messages, and author strings with `AdversarialPromptDefense` before passing to model prompt.
  - **Commands**: `/status`, `/diff`, `/log`, `/blame`, `/pr-description`.
- **New Settings**:
  - `localCopilot.git.protectedBranches`: `string[]` (default: `["main", "master", "release/*"]`).

#### 4. Test Plan
- Unit test: `test/unit/gitIntelligence.test.ts` (prohibited git operations blocked, dirty tree detection, commit style inference, injection in branch name neutralized).
- Real integration test: `test/real-integration/gitIntelligenceReal.test.ts` on fixture git repository.

#### 5. Acceptance Criteria
- Prohibited git commands are blocked 100%.
- Git metadata injection payloads are neutralized before prompt construction.

#### 6. Rollback Plan
- Git features operate read-only and require manual confirmation for `/commit`.

#### 7. Open Questions
- Should `/pr-description` generate GitHub Markdown format? *(Recommendation: Yes, standard GitHub PR template format).*

---

### Deliverable 11.8: Status Bar, Accessibility & Help

#### 1. Current-State Findings
- Status bar currently displays connection health via `ChatViewProvider` ([`src/providers/chatViewProvider.ts#L210-L240`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L210-L240)).
- Lacks active mode indicator (Plan vs Agent vs Chat), token budget usage percentage, and screen-reader accessible streaming pace.

#### 2. Risks & Failure Modes
- Token-by-token live screen reader announcements flooding audio buffers.

#### 3. Proposed Design
- Implement `LocalCopilotStatusBar` (`src/providers/statusBarProvider.ts`):
  - Displays: `$(sparkle) Copilot: [Model] | [Mode] | [Ctx: 42%]`.
  - Clicking status bar opens menu: Switch Model, Toggle Plan Mode, View Context Breakdown, Open Terminal.
- **Accessibility Hardening**:
  - Webview and terminal elements adhere to WAI-ARIA standards (`role="log"`, `aria-live="polite"`).
  - Streaming updates throttled to batches (e.g. every 150ms) to prevent screen-reader stutter.
  - Respects `prefers-reduced-motion` and VS Code high-contrast themes.
  - Comprehensive `/help` interactive guide.

#### 4. Test Plan
- Unit test: `test/unit/accessibilityAndStatus.test.ts` (ARIA attributes validation, status bar state updates).

#### 5. Acceptance Criteria
- Keyboard-only navigation functional across webview and terminal.
- Throttled streaming delivers zero audio flood in screen reader testing.

#### 6. Rollback Plan
- Status bar items can be hidden via VS Code context menu.

#### 7. Open Questions
- Should context percentage turn yellow above 80% and red above 90%? *(Recommendation: Yes, clear visual warning thresholds).*

---

### Deliverable 11.9: Phase 11 Verification & Evaluation

#### 1. Current-State Findings
- Existing unit tests total 361 tests across 41 suites ([`package.json#L47`](file:///c:/Projects/local-copilot-chat/package.json#L47)). Real integration tests total 23 passing, 3 pending offline across 7 suites ([`test/real-integration/`](file:///c:/Projects/local-copilot-chat/test/real-integration/)).
- The 30-task benchmark corpus exists at [`test/real-integration/benchmarkTaskCorpus.ts#L1-L320`](file:///c:/Projects/local-copilot-chat/test/real-integration/benchmarkTaskCorpus.ts#L1-L320) but lacks automated evaluation against interactive terminal sessions and session compaction fidelity.

#### 2. Risks & Failure Modes
- Regressions in agent code repair or refactoring introduced by the `SessionEngine` refactoring could go undetected if only basic unit tests are executed.
- Terminal escape sequences could cause terminal emulation crashes or visual corruption in VS Code Extension Host.

#### 3. Proposed Design
- Implement Phase 11 Verification Suite:
  - Execute full 30-task benchmark corpus (`benchmarkTaskCorpus.ts`) to prove Phase 11 introduces zero regression to code generation, repair, or refactoring capabilities.
  - Execute seeded-fact compaction fidelity benchmark measuring needle retrieval and state preservation across 50-turn simulated sessions.
  - Execute terminal escape sequence and ANSI fuzzing suite verifying robustness against malformed model outputs.
  - Execute session migration verification verifying lossless upgrade of legacy v1 sessions.
  - Generate manual QA checklist for interactive UI interactions that cannot be automated headlessly.

#### 4. Test Plan
- Unit tests: `test/unit/phase11Verification.test.ts` (verifies verification suite harness, assertion logic, and report synthesizer).
- Integration tests: `test/real-integration/phase11Regression.test.ts` (offline execution of full 30-task benchmark against deterministic mocks and recorded transcripts).

#### 5. Acceptance Criteria
- Zero regression in task pass rate across the 30-task benchmark corpus compared to the Phase 10 baseline.
- 100% passing tests across all new Phase 11 test suites with zero skipped unit tests.
- Compaction fidelity benchmark demonstrates $\ge 90\%$ fact retention.

#### 6. Rollback Plan
- If regressions occur, isolate the offending deliverable (e.g. compaction or plan mode dispatch) and restore previous behavior via configuration toggles or submodule rollback.

#### 7. Open Questions
- Should regression benchmarking run automatically in CI on every commit? *(Recommendation: Run mock-backed benchmark in CI; run live GPU benchmark during release milestones).*

---

# SECTION 2: PHASE 12 — MODEL INTELLIGENCE & OPTIMIZATION

---

### Deliverable 12.0: Hardware & Measurement Environment

#### 1. Current-State Findings
- `HardwareCapacityManager` ([`src/services/hardwareCapacityManager.ts#L25-L65`](file:///c:/Projects/local-copilot-chat/src/services/hardwareCapacityManager.ts#L25-L65)) enforces 8 GB VRAM budget limits, but lacks automated hardware fingerprint extraction (GPU driver version, system RAM, CPU specs, Ollama version).

#### 2. Risks & Failure Modes
- Comparing benchmark results across different hardware configurations, driver updates, or thermal throttling states yields invalid conclusions.

#### 3. Proposed Design
- Implement `MeasurementEnvironment` (`src/services/measurementEnvironment.ts`):
  - Captures immutable hardware/software fingerprint:
    ```typescript
    interface HardwareFingerprint {
      timestamp: string;
      os: string;
      cpuModel: string;
      totalRamGb: number;
      gpuModel: string;
      gpuVramBytes: number;
      gpuDriverVersion?: string;
      ollamaVersion: string;
      gitCommitSha: string;
    }
    ```
  - **Measurement Controls**:
    - Records cold load (model initial load) vs warm load (subsequent inference turns) separately.
    - Fixed seed (`seed: 42`) and temperature (`temperature: 0.1`) during benchmarking.
    - Pre-run idle GPU check via `GET http://127.0.0.1:11434/api/ps`: warns if external processes hold VRAM.
    - Repetition requirement: $N \ge 3$ repetitions with variance and min/max reporting.
- **New Settings**:
  - `localCopilot.benchmark.repetitions`: `number` (default: `3`).

#### 4. Test Plan
- Unit test: `test/unit/measurementEnvironment.test.ts` (fingerprint capture schema, idle check logic, statistical variance helper).

#### 5. Acceptance Criteria
- All benchmark results contain verified hardware fingerprints; differences within noise are labeled "statistically indistinguishable".

#### 6. Rollback Plan
- Non-intrusive metadata recording; no runtime behavior impact.

#### 7. Open Questions
- If Ollama is running in WSL2, should WSL2 virtualized GPU stats be captured? *(Recommendation: query `/api/ps` directly for actual allocated GPU VRAM).*

---

### Deliverable 12.1: Model-Parametric Benchmark Harness

#### 1. Current-State Findings
- Phase 9.0 implemented `BENCHMARK_CORPUS_30` ([`src/services/benchmarkTaskCorpus.ts`](file:///c:/Projects/local-copilot-chat/src/services/benchmarkTaskCorpus.ts)) and `EvaluationService` ([`src/services/evaluationService.ts`](file:///c:/Projects/local-copilot-chat/src/services/evaluationService.ts)).
- Currently executes against a single hardcoded or requested model without automated model sweep, throughput telemetry (prompt-eval tokens/sec vs generation tokens/sec), or failure taxonomy categorization.

#### 2. Risks & Failure Modes
- Running automated model sweeps without pause could trigger multi-model thrashing or VRAM out-of-memory errors on 8 GB cards.

#### 3. Proposed Design
- Upgrade `EvaluationService` to Model-Parametric Harness:
  - Iterates over requested models sequentially, using `ModelLifecycleManager` to cleanly unload model $A$ before loading model $B$.
  - **Telemetry Captured Per Task**:
    - Prompt evaluation tokens/sec (`prompt_eval_count / prompt_eval_duration`).
    - Generation tokens/sec (`eval_count / eval_duration`).
    - Time-to-first-token (TTFT).
    - Model load duration.
    - Peak VRAM (`size_vram` from `/api/ps`).
    - GPU vs CPU offload ratio (`size_vram / size`).
    - **Failure Taxonomy**: `SYNTAX_ERROR`, `WRONG_TOOL`, `PATH_TRAVERSAL_REJECTED`, `TEST_WEAKENING_REJECTED`, `TIMEOUT`, `CONTEXT_OVERFLOW`.
  - **Output Generator**: Produces `benchmark-results-<runId>.json` and formatted Markdown comparison tables.
  - **Cancellable & Resumable**: Interrupted benchmark runs resume from the last completed task.
- **Commands**: `/benchmark [model1, model2, ...]`, `/benchmark report`.

#### 4. Test Plan
- Unit test: `test/unit/parametricBenchmark.test.ts` (offline mock LLM runner, failure taxonomy classification, resumable state persistence).

#### 5. Acceptance Criteria
- Complete metrics capture per model with zero VRAM leaks during sequential model transitions.

#### 6. Rollback Plan
- Existing single-model `/benchmark` remains available.

#### 7. Open Questions
- Should the benchmark harness allow running only a subset category (e.g. `/benchmark --category code_repair`)? *(Recommendation: Yes, support category filter flag).*

---

### Deliverable 12.2: Quantization Evaluation

#### 1. Current-State Findings
- The repository currently does not evaluate quantization variants (e.g. `q4_K_M`, `q5_K_M`, `q8_0`) on this specific hardware.

#### 2. Risks & Failure Modes
- Downloading large quantization variants without user confirmation consumes disk space and network bandwidth.
- Higher quants (q8_0) on 9B-14B models exceed 8 GB VRAM, causing slow CPU spillover.

#### 3. Proposed Design
- Implement Quantization Evaluator in `ModelIntelligenceService` (`src/services/modelIntelligenceService.ts`):
  - Discovers locally available quantization tags via `GET /api/tags`.
  - Evaluates available quants on benchmark tasks measuring quality score vs VRAM vs tokens/sec.
  - Generates a **Pareto Frontier Table**: identifies the highest-quality quant that fits 100% inside 8 GB VRAM at standard `numCtx`.
  - **Hard Rule Compliance**: Does NOT download or pull models automatically. Only models already pulled locally or explicitly approved by the user are tested.

#### 4. Test Plan
- Unit test: `test/unit/quantizationEvaluation.test.ts` (Pareto frontier calculation, offline mock data).

#### 5. Acceptance Criteria
- Clear, empirical Pareto frontier generated from measured data on this machine.

#### 6. Rollback Plan
- Report generator only; no runtime side-effects.

#### 7. Open Questions
- Which base model should be chosen for the primary quant sweep? *(Recommendation: `qwen2.5-coder:7b` since it is already installed locally).*

---

### Deliverable 12.3: Context-Window Optimization & Prefix Caching

#### 1. Current-State Findings
- `ConfigurationService` ([`src/services/configurationService.ts#L35`](file:///c:/Projects/local-copilot-chat/src/services/configurationService.ts#L35)) defaults `numCtx` to 16384 or 8192 without measuring the exact VRAM impact or effective context curve.

#### 2. Risks & Failure Modes
- Setting `numCtx` too large (e.g. 32k) on an 8 GB card causes Ollama to offload KV-cache or layers to CPU, causing a 10x drop in tokens/sec.
- Modifying `numCtx` dynamically per turn causes Ollama to reload the model from scratch, destroying prompt cache.

#### 3. Proposed Design
- Implement Context Window Profiler:
  - Measures VRAM, throughput, and retrieval pass rate across context fill levels (25%, 50%, 75%, 100% of 4k, 8k, 16k, 32k).
  - Identifies the exact "VRAM Cliff" where CPU offload occurs.
  - Runtime detection via `/api/ps`: If `size_vram < size`, surfaces informational status bar warning: `$(warning) Partial CPU Offload Active (Slowdown expected)`.
  - **Prefix-Cache Prompt Stabilization**:
    - Keeps System Prompt, Tool Definitions, and Architecture Map byte-stable at the start of prompt arrays so Ollama reuses its KV prompt cache across turns without re-evaluating unchanged tokens.
- **New Settings**:
  - `localCopilot.context.warnOnCpuOffload`: `boolean` (default: `true`).

#### 4. Test Plan
- Unit test: `test/unit/contextOptimization.test.ts` (CPU offload detection parser, prefix cache stability validator).

#### 5. Acceptance Criteria
- Runtime warning triggered whenever partial CPU offload is detected from `/api/ps`.
- Prefix cache byte stability verified across consecutive turns.

#### 6. Rollback Plan
- Warning can be disabled via setting.

#### 7. Open Questions
- Should `numCtx` default to 8192 for 7B models on 8 GB cards? *(Recommendation: Yes, 8192 maintains full GPU residency without offload).*

---

### Deliverable 12.4: Deterministic ModelRouter & Profile Schema

#### 1. Current-State Findings
- Phase 2 introduced a basic heuristic keyword matcher in `modelRouter.ts`, but it uses hardcoded model names and lacks empirical model capability profiles.

#### 2. Risks & Failure Modes
- Frequent model switching under single-model residency incurs a 4–8 second model reload delay. If the benefit is marginal, switching degrades user experience.

#### 3. Proposed Design
- Implement Empirical `ModelRouter` (`src/services/modelRouter.ts`):
  - **Model Profile Schema**:
    ```typescript
    interface ModelProfile {
      modelTag: string;
      fingerprint: HardwareFingerprint;
      measuredTps: number;
      vramBytes: number;
      effectiveContextTokens: number;
      toolCallReliability: number; // 0.0 - 1.0
      categoryStrengths: Record<BenchmarkCategory, number>;
      swapCostMs: number;
    }
    ```
  - Stored in `.vscode/local-copilot/model-profiles/<modelTag>.json`.
  - **Swap-Cost Aware Routing Policy**:
    - Stays on current resident model unless the target model's measured capability on the task class exceeds current model capability by more than the measured swap cost penalty.
  - **Task Classifier**:
    - Maps `chat_explain` -> fast reasoning model.
    - Maps `code_repair` / `feature_gen` -> coder model.
  - User model override setting always takes precedence.
- **New Settings**:
  - `localCopilot.router.enabled`: `boolean` (default: `false` - ships OFF until empirical profile is captured).

#### 4. Test Plan
- Unit test: `test/unit/modelRouterProfile.test.ts` (profile schema validation, swap-cost calculation, fallback on missing model).

#### 5. Acceptance Criteria
- Router ships OFF by default; when enabled, respects user pin overrides and minimizes unnecessary model reloads.

#### 6. Rollback Plan
- Disabling router locks extension to `localCopilot.defaultModel`.

#### 7. Open Questions
- What minimum pass-rate delta justifies a model swap? *(Recommendation: at least +15% expected pass rate to justify 5s swap latency).*

---

### Deliverable 12.5: Local Inference Performance & Overhead Profiling

#### 1. Current-State Findings
- Extension request parameters (`num_ctx`, `temperature`, `top_p`) are passed to Ollama, but request-level concurrency knobs (`num_batch`, `num_thread`) are untuned.

#### 2. Risks & Failure Modes
- Over-allocating worker threads on CPU can starve Windows UI and extension host event loop.

#### 3. Proposed Design
- Implement Performance Profiler:
  - Profiles extension-host internal latency: JSON parsing time, webview postMessage batching, repo-map AST extraction time.
  - Measures tokens/sec across `num_thread` values (e.g. 4 vs 6 vs 8 on host CPU).
  - Surfaces runtime health alert if generation speed drops below 50% of model profile baseline (indicating external GPU contention).
  - Documents server-level knobs (`OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`) in documentation for optional user configuration.

#### 4. Test Plan
- Unit test: `test/unit/inferencePerformance.test.ts` (options mapper, performance health alert logic).

#### 5. Acceptance Criteria
- Extension internal processing overhead remains $< 5\%$ of total turn duration.

#### 6. Rollback Plan
- Request parameters fall back to standard defaults if profiling is disabled.

#### 7. Open Questions
- Does Ollama v0.40.7 on Windows support flash attention? *(Recommendation: Document as optional flag requiring manual user verification).*

---

### Deliverable 12.6: Model Calibration Command (`/tune`)

#### 1. Current-State Findings
- No unified calibration wizard exists in the extension.

#### 2. Risks & Failure Modes
- Running tuning tasks could interrupt an active coding conversation or evict external tools' models.

#### 3. Proposed Design
- Implement `/tune` slash command (`src/services/calibrationWizard.ts`):
  - Displays pre-flight confirmation with estimated duration and VRAM requirements.
  - Respects `ModelLifecycleManager` external model ownership rules.
  - Runs bounded calibration suite (cold load, TTFT, generation tokens/sec, tool-call syntax check).
  - Generates and writes `ModelProfile` atomically.
  - Restores prior active session and model state upon completion or cancellation.

#### 4. Test Plan
- Unit test: `test/unit/calibrationWizard.test.ts` (pre-flight checks, state restoration, profile output).

#### 5. Acceptance Criteria
- Calibration runs cleanly, never touches external models, and restores state upon cancellation.

#### 6. Rollback Plan
- Calibration is purely opt-in; no automatic execution.

#### 7. Open Questions
- Should `/tune` run in a dedicated terminal or in the chat webview? *(Recommendation: in the active front-end with live progress bar).*

---

### Deliverable 12.7: Phase 12 Evaluation & Results Generator

#### 1. Current-State Findings
- Test reports are currently written manually in `engineering/` (e.g. [`engineering/phase_8_validation_report.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_8_validation_report.md), [`engineering/phase_10_completion_report.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_10_completion_report.md)).
- Raw benchmark execution outputs lack automated, reproducible Markdown synthesis linking hardware metrics to benchmark task matrices.

#### 2. Risks & Failure Modes
- Discrepancies between raw JSON telemetry data and published Markdown tables if manually transcribed.
- Incomplete runs or small sample sizes ($N < 3$) presenting misleading conclusions if statistical significance is unflagged.

#### 3. Proposed Design
- Implement automated report synthesizer (`src/services/benchmarkReportGenerator.ts`):
  - Generates `engineering/phase_12_results.md` directly from stored benchmark telemetry JSON files (`benchmark-results/*.json`).
  - Includes hardware fingerprint (GPU model, driver, VRAM, RAM, CPU), model comparison tables, latency curves, throughput boxplots/ASCII curves, and statistical confidence intervals (mean, standard deviation, p95).
  - Explicitly flags results with insufficient sample sizes as `"Pending user measurement"`.
  - Enforces Rule 12: Zero unmeasured assertions in generated documentation.

#### 4. Test Plan
- Unit tests: `test/unit/benchmarkReportGenerator.test.ts` (validates parsing of benchmark JSON fixtures, calculation of standard deviations, rendering of Markdown tables, and handling of incomplete datasets).

#### 5. Acceptance Criteria
- Synthesizer automatically parses benchmark JSON runs and produces valid GitHub Flavored Markdown.
- Generates exact diff comparison tables across quantization levels, context lengths, and models.
- All numbers match raw JSON telemetry down to the millisecond and token/sec.

#### 6. Rollback Plan
- Report generation is read-only and non-destructive; can be re-run or regenerated at any time from raw benchmark JSON artifacts.

#### 7. Open Questions
- Should the report generator output interactive HTML graphs via webview or static Markdown tables? *(Recommendation: Static Markdown tables and ASCII graphs for version control; optional webview preview).*

---

# SECTION 3: DELIVERABLE DOC — MASTER DOCUMENTATION SUITE

### Deliverable DOC: Comprehensive Documentation Updates

#### 1. Current-State Findings
- Core documentation files exist: [`PLAN.md`](file:///c:/Projects/local-copilot-chat/PLAN.md), [`TECHNICAL_DOCUMENTATION.md`](file:///c:/Projects/local-copilot-chat/TECHNICAL_DOCUMENTATION.md), [`IMPLEMENTATION_STATUS.md`](file:///c:/Projects/local-copilot-chat/IMPLEMENTATION_STATUS.md), [`THREAT_MODEL.md`](file:///c:/Projects/local-copilot-chat/THREAT_MODEL.md), [`README.md`](file:///c:/Projects/local-copilot-chat/README.md), and [`CHANGELOG.md`](file:///c:/Projects/local-copilot-chat/CHANGELOG.md).
- Architectural changes introduced in Phase 11 (`SessionEngine`, `AgentTerminalProvider`, `CheckpointManager`, `ApprovalPolicyEngine`, `GitIntelligenceService`) and Phase 12 (`MeasurementEnvironment`, `ParametricBenchmarkHarness`, `ModelRouter`, `CalibrationCommand`) must be comprehensively and accurately documented.

#### 2. Risks & Failure Modes
- Documentation drift: docs describing idealized or planned behavior rather than verified reality.
- Broken file links or inaccurate symbol references.

#### 3. Proposed Design
- Update and synchronize all documentation files adhering strictly to verified reality:
  1. **`PLAN.md`**: Update Mermaid roadmap and Live Status Matrix with Phase 11 and Phase 12 statuses, verified test counts, and architecture checkpoints.
  2. **`TECHNICAL_DOCUMENTATION.md`**: Add architecture specifications, sequence diagrams, public APIs, and invariants for `SessionEngine`, `AgentTerminalProvider`, `SessionPersistenceService`, `CheckpointManager`, `ApprovalPolicyEngine`, `GitIntelligenceService`, and `ModelRouter`.
  3. **`IMPLEMENTATION_STATUS.md`**: Add per-deliverable implementation tracking with verified file:line evidence links.
  4. **`THREAT_MODEL.md`**: Add terminal escape/OSC injection mitigations, prompt spoofing defenses, session tamper guards, and repo-shipped rule protections.
  5. **`README.md`**: Document terminal usage, plan mode, checkpoints, `/rewind`, approvals, status bar, and hardware recommendations.
  6. **`CHANGELOG.md`**: Structured release notes for Phase 11 and Phase 12 deliverables.
  7. **Dedicated Documentation Guides**:
     - `docs/BENCHMARKING.md`: Methodology, metrics, task schemas, statistical guidelines.
     - `docs/MODEL_GUIDE.md`: Measured model recommendations for 8 GB VRAM.
     - `docs/PERFORMANCE_TUNING.md`: Request knobs, prefix caching, CPU offload mitigation.
     - `docs/DEVELOPER_GUIDE.md`: Extending slash commands, approval rules, and benchmark tasks.

#### 4. Test Plan
- Automated link checker verifying all markdown file links and symbols resolve.
- Markdown linter verifying consistent GFM syntax and diagram formatting.
- Audit against codebase confirming zero discrepancy between implementation and docs.

#### 5. Acceptance Criteria
- All 6 core documents and 4 dedicated guides updated and synchronized.
- Zero broken markdown links (`file:///` links valid).
- Zero unmeasured claims or fabricated benchmark figures.

#### 6. Rollback Plan
- Git-tracked documentation can be reverted via standard file checkout if inaccuracies are detected.

#### 7. Open Questions
- Should dedicated docs reside in `docs/` or `engineering/`? *(Recommendation: User-facing guides in `docs/`; milestone reports in `engineering/`).*

---

# SECTION 4: SEQUENCING EVALUATION & RECOMMENDATIONS

### Evaluation of Pulling Forward 12.0 & 12.1 Ahead of Phase 11

The sequencing relationship between Phase 11 and Phase 12 was carefully evaluated:
- **Phase 11 Dependency**:
  - Deliverable 11.0 requires capturing a rigorous performance and quality baseline before refactoring the `SessionEngine`.
  - Deliverable 11.3 requires evaluating compaction fidelity and tuning thresholds based on context-window capacity.
  - Rule 6 states: *"NO IMPROVEMENT WITHOUT MEASUREMENT. Capture a baseline before changing behavior."*
- **Phase 12 Instruments**:
  - Deliverable 12.0 provides the immutable hardware fingerprinting and statistical measurement controls ($N \ge 3$, variance, fixed seeds).
  - Deliverable 12.1 provides the model-parametric benchmark harness and structured JSON telemetry generator.

### Architectural Recommendation:
> [!TIP]
> **RECOMMENDATION**: **Pull forward Deliverables 12.0 and 12.1 ahead of Phase 11 implementation.**  
> Implementing the measurement instruments (12.0 Hardware Fingerprinting and 12.1 Parametric Benchmark Harness) first equips us with the exact measurement tooling required to baseline 11.0, verify zero regressions during Phase 11 refactoring, and measure compaction fidelity in 11.3.  
> The remaining Phase 12 deliverables (12.2 Quantization, 12.3 Context Curves, 12.4 ModelRouter, 12.5 Performance Tuning, 12.6 Calibration) remain in Phase 12 as scheduled.

### Dependency Graph

```mermaid
flowchart TD
    P10["Phase 10 Swarm Baseline (361 tests)"] --> D12_0["12.0: Measurement Environment & Fingerprint"]
    D12_0 --> D12_1["12.1: Model-Parametric Benchmark Harness"]
    D12_1 --> D11_0["11.0: Baseline Capture & SessionEngine Extraction"]
    D11_0 --> D11_1["11.1: Interactive Agent Pseudoterminal"]
    D11_0 --> D11_2["11.2: Persistent Sessions & Migration"]
    D11_0 --> D11_4["11.4: Read-Only Plan Mode"]
    D11_0 --> D11_5["11.5: Content-Addressed Checkpoints"]
    D11_0 --> D11_6["11.6: Unified Approval Policy Engine"]
    D11_0 --> D11_7["11.7: Git-Aware Development"]
    D11_1 & D11_2 & D11_4 & D11_5 & D11_6 & D11_7 --> D11_3["11.3: Tiered Context Compaction & Fidelity"]
    D11_3 --> D11_8["11.8: Status Bar & Accessibility"]
    D11_8 --> D11_9["11.9: Phase 11 Verification & Evaluation"]
    D11_9 --> D12_2["12.2: Quantization Evaluation"]
    D12_2 --> D12_3["12.3: Context-Window Optimization & Prefix Cache"]
    D12_3 --> D12_4["12.4: Deterministic ModelRouter"]
    D12_4 --> D12_5["12.5: Local Inference Performance & Tuning"]
    D12_5 --> D12_6["12.6: Calibration Command (/tune)"]
    D12_6 --> D12_7["12.7: Phase 12 Evaluation Report"]
    D12_7 --> DOC["Deliverable DOC: Master Documentation Suite"]
```

### Implementation Order
The recommended execution order strictly follows the dependency graph:

1. **Stage Prep: Phase 12 Measurement Instruments (Prep Gate)**:
   - `12.0`: Hardware & Measurement Environment (`src/services/measurementEnvironment.ts`)
   - `12.1`: Model-Parametric Benchmark Harness (`src/services/parametricBenchmarkHarness.ts`)
2. **Stage B: Phase 11 Claude Code-Level Developer Experience**:
   - `11.0`: Baseline Capture & SessionEngine Extraction (`src/services/sessionEngine.ts`)
   - `11.1`: Interactive Agent Pseudoterminal (`src/terminal/agentTerminalProvider.ts`)
   - `11.2`: Persistent Sessions & Multi-Window Safety (`src/services/sessionPersistenceService.ts`)
   - `11.4`: Read-Only Plan Mode & Strict Dispatcher Enforcement (`src/services/planModeDispatcher.ts`)
   - `11.5`: Content-Addressed Local Checkpoints & File Rewind (`src/services/checkpointManager.ts`)
   - `11.6`: Unified Approval Policy Engine & Grant Storage (`src/services/approvalPolicyEngine.ts`)
   - `11.7`: Git-Aware Development (`src/services/gitIntelligenceService.ts`)
   - `11.3`: Intelligent Tiered Context Compaction & Fidelity Harness (`src/services/contextCompactionService.ts`)
   - `11.8`: Status Bar & Accessibility (`src/providers/statusBarProvider.ts`)
   - `11.9`: Phase 11 Verification & Evaluation (`test/real-integration/phase11Regression.test.ts`)
3. **Stage C: Phase 12 Model Intelligence & Optimization**:
   - `12.2`: Quantization Evaluation (`src/services/quantizationEvaluator.ts`)
   - `12.3`: Context-Window Optimization & Prefix Caching (`src/services/contextOptimizer.ts`)
   - `12.4`: Deterministic ModelRouter & Profile Schema (`src/services/modelRouter.ts`)
   - `12.5`: Local Inference Performance & Overhead Profiling (`src/services/inferenceProfiler.ts`)
   - `12.6`: Model Calibration Command (`/tune`) (`src/commands/calibrationCommand.ts`)
   - `12.7`: Phase 12 Evaluation & Results Generator (`src/services/benchmarkReportGenerator.ts`)
4. **Stage D: Deliverable DOC Master Documentation Suite**:
   - Synchronize all 6 root docs and author 4 dedicated guides.

### Items to Defer or Cut
1. **Dynamic In-Turn `numCtx` Switching**: *Cut*. Resizing context dynamically forces Ollama model reload and invalidates prompt cache, producing 5s+ stalls. Fixed 8k context is maintained.
2. **Dual-Model Speculative Decoding**: *Cut*. Running draft + verifier models exceeds 8 GB VRAM.
3. **Native Linux/macOS PTY C-bindings (`node-pty`)**: *Defer*. Native C++ compilation complicates cross-platform VS Code extension packaging and installation. VS Code API `Pseudoterminal` provides standard, native cross-platform support without binary dependencies.
4. **Cloud/Remote Benchmark Sync**: *Cut*. Local-first privacy principle strictly prohibits exfiltrating benchmark telemetry.

### Results that Require User GPU or Approval
1. **Live Ollama Inference Benchmarking**: Executing live multi-model benchmark runs against the host GPU (`qwen2.5-coder:7b`, `deepseek-r1:8b`, etc.) requires the host Ollama daemon to be running and dedicated GPU compute time (~15-30 minutes of uninterrupted inference).
2. **Model Calibration Command (`/tune`) Live Run**: Requires running an automated inference sweep against the local Ollama instance on the user's active GPU.
3. **Model Weights Download / Quantization Swaps**: Any pulling of alternative model tags (e.g. Q4 vs Q8) requires user approval, disk space, and network bandwidth.

### Items Unlikely to Yield Measurable Gains on 8 GB VRAM:
1. **Dynamic In-Turn numCtx Switching**: Reloading models mid-task to adjust context size destroys prompt cache and incurs 5s latency; keeping a stable 8k `numCtx` is far superior.
2. **Concurrent Multi-Model Running**: Running multiple models simultaneously on an 8 GB card causes severe GPU memory thrashing or CPU spillover; serialized single-model residency must be maintained.
3. **Speculative Decoding with Draft Models**: Running both a draft model and a target model simultaneously exceeds 8 GB VRAM; unsupported on this hardware profile.

---

## Stage A Status: Design Complete

> [!IMPORTANT]
> **GATE REACHED:** In compliance with the Controlled Workflow:
> - Zero source files, test files, or configurations have been modified.
> - Zero Git commits or working tree modifications have been executed.
> - The complete technical design covering Phase 11 and Phase 12 has been written to `engineering/phase_11_12_design.md`.

---

# ADDENDUM: STAGE 0 VERIFICATION & READ-ONLY FOLLOW-UPS

This addendum records the complete Stage 0 verification findings, exact baseline command outputs, Git state inventory, design completeness audit, consolidated open questions, and local model profile prior to Phase 12-Prep implementation.

---

## 1. Consolidated Open Questions & Recommended Defaults

All open questions across Phase 11, Phase 12, and Deliverable DOC are consolidated below with concrete recommended defaults:

| # | Deliverable | Question | Recommended Default |
|---|-------------|----------|---------------------|
| 1 | **11.0: SessionEngine Extraction** | Should session transcripts retain `<think>` tokens when persisted, or continue strict suppression? | **Suppress from prompt history; retain in debug transcript.** Keeps prompt context clean while allowing offline reasoning inspection. |
| 2 | **11.1: Interactive Agent Pseudoterminal** | Should the agent terminal launch automatically on IDE startup? | **No.** Launch only via explicit command (`Local Copilot: Open Agent Terminal`) or status bar click to prevent unwanted resource usage. |
| 3 | **11.2: Persistent Sessions & Multi-Window** | Should session export support HTML format or only Markdown/JSON? | **Markdown and JSON only.** Avoids HTML sanitizer complexity and eliminates XSS attack surface. |
| 4 | **11.3: Tiered Context Compaction** | When `numCtx` is small (4096), should Tier 3 LLM summarization be skipped in favor of Tier 1+2? | **Yes.** Skip Tier 3 if available token headroom is $< 1000$ tokens to prevent compaction from consuming remaining context. |
| 5 | **11.4: Read-Only Plan Mode** | Should Plan Mode allow read-only terminal commands like `npm test`? | **No.** Terminal execution remains strictly Tier 2/3 and requires normal execution mode with policy approvals. |
| 6 | **11.5: Content-Addressed Checkpoints** | Should untracked files created by the agent be deleted on rewind? | **Yes, with explicit user confirmation.** Created files are deleted after confirmation, with full backup preserved in `.vscode/local-copilot/checkpoints/blobs/`. |
| 7 | **11.6: Unified Approval Policy Engine** | Should session grants expire after 1 hour of inactivity? | **Yes.** Enforce a 1-hour session grant TTL to prevent stale authorization lingering across idle sessions. |
| 8 | **11.7: Git-Aware Development** | Should `/pr-description` generate GitHub Markdown format? | **Yes.** Standard GitHub PR template format with summary, change matrix, test evidence, and risk assessment. |
| 9 | **11.8: Status Bar & Accessibility** | Should context percentage turn yellow above 80% and red above 90%? | **Yes.** Clear visual warning thresholds: green $\le 80\%$, yellow $> 80\%$, red $> 90\%$. |
| 10 | **11.9: Phase 11 Verification** | Should regression benchmarking run automatically in CI on every commit? | **Run mock-backed benchmark in CI; run live GPU benchmark during release milestones.** Keeps CI fast while maintaining empirical gating. |
| 11 | **12.0: Hardware & Measurement** | If Ollama is running in WSL2, should WSL2 virtualized GPU stats be captured? | **Query Ollama `/api/ps` directly.** Returns actual allocated GPU VRAM regardless of host vs WSL2 virtualization layer. |
| 12 | **12.1: Parametric Benchmark Harness** | Should the benchmark harness allow running only a subset category? | **Yes.** Support `--category` filter (e.g. `--category code_repair`, `--category refactoring`). |
| 13 | **12.2: Quantization Evaluation** | Which base model should be chosen for the primary quantization sweep? | **`qwen2.5-coder:7b`.** Primary coding baseline already installed locally on host disk. |
| 14 | **12.3: Context-Window Optimization** | Should `numCtx` default to 8192 for 7B models on 8 GB cards? | **Yes.** 8192 maintains 100% GPU residency with zero CPU spillover on 8 GB VRAM. |
| 15 | **12.4: Deterministic ModelRouter** | What minimum pass-rate delta justifies a dynamic model swap? | **At least $+15\%$ expected pass rate.** Offsets the 4–6 second Ollama model reload latency. |
| 16 | **12.5: Inference Performance Tuning** | Does Ollama v0.40.7 on Windows support flash attention? | **Document as optional configuration flag.** Requires user GPU verification; default to Ollama standard backend. |
| 17 | **12.6: Model Calibration (`/tune`)** | Should `/tune` run in a dedicated terminal or in the chat webview? | **In the active front-end.** Displays interactive ASCII progress bars and live throughput telemetry. |
| 18 | **12.7: Phase 12 Evaluation Report** | Should report generator output interactive HTML graphs or static Markdown? | **Static Markdown tables and ASCII curves.** Fully version-controllable in git; optional webview preview. |
| 19 | **DOC: Master Documentation Suite** | Should dedicated docs reside in `docs/` or `engineering/`? | **User-facing guides in `docs/`; milestone engineering reports in `engineering/`.** Clean separation of concerns. |

---

## 2. Full Stage 0 Audit Report

A complete, line-by-line inspection of [`engineering/phase_8_completion_report.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_8_completion_report.md), [`engineering/phase_9_completion_report.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_9_completion_report.md), [`engineering/phase_10_completion_report.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_10_completion_report.md), and [`engineering/phase_8_validation_report.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_8_validation_report.md) was performed.

### 2.1 Features Shipped OFF by Default or Disabled
1. **Reflection Loop (`localCopilot.agentic.reflectionLoopEnabled = false`)**:
   - Location: [`src/services/agentLoop.ts#L43-L45`](file:///c:/Projects/local-copilot-chat/src/services/agentLoop.ts#L43-L45)
   - Status: Shipped OFF by default.
   - Reason: Phase 9 benchmark showed reflection loops on 7B models increase latency and token consumption without measurable pass-rate improvement unless explicitly triggered.
2. **Speculative Routing (`localCopilot.agentic.speculativeRoutingEnabled = false`)**:
   - Location: [`src/services/agentLoop.ts#L46`](file:///c:/Projects/local-copilot-chat/src/services/agentLoop.ts#L46)
   - Status: Shipped OFF by default.
   - Reason: Requires empirical latency profiling from Phase 12 before enabling.
3. **Independent Reviewer Gating (`localCopilot.agentic.reflectionRequiresReviewer = true`)**:
   - Location: [`src/services/agentLoop.ts#L47`](file:///c:/Projects/local-copilot-chat/src/services/agentLoop.ts#L47)
   - Status: Enforced by default to prevent autonomous loops without oversight.
4. **MemoryService Vector RAG Prompt Injection**:
   - Location: [`src/services/memoryService.ts#L101-L125`](file:///c:/Projects/local-copilot-chat/src/services/memoryService.ts#L101-L125)
   - Status: Omitted from the active agent prompt assembly loop.
   - Reason: Running `nomic-embed-text` concurrently with the code LLM breaches the 8 GB single-model VRAM residency budget.
5. **ModelRouter Dynamic Model Switching (`localCopilot.router.enabled = false`)**:
   - Location: [`src/services/modelRouter.ts`](file:///c:/Projects/local-copilot-chat/src/services/modelRouter.ts)
   - Status: Shipped OFF by default.
   - Reason: Model swap latency (4–6s) degrades responsiveness unless justified by a verified $\ge 15\%$ quality gain.
6. **Swarm Sub-Agent Parallelism**:
   - Location: [`src/services/swarmCoordinator.ts`](file:///c:/Projects/local-copilot-chat/src/services/swarmCoordinator.ts)
   - Status: Fixed at concurrency = 1 (strictly serialized).
   - Reason: Concurrent inference of multiple agents exhausts 8 GB VRAM.
7. **Dynamic In-Turn `numCtx` Switching**:
   - Status: Explicitly rejected / disabled.
   - Reason: Dynamically changing context window triggers full Ollama model reload, evicting prompt cache and causing 5s stalls.
8. **Speculative Decoding with Draft Models**:
   - Status: Disabled / unsupported.
   - Reason: Draft + target model exceeds 8 GB VRAM.

### 2.2 Items Marked "Not Verified" or "Cannot Verify Here"
1. **Live Ollama Inference Suite (`test/real-integration/liveOllama.test.ts`)**:
   - 3 tests dynamically skipped when Ollama daemon is offline (`ECONNREFUSED` on port 11434). Verified offline mock tier passes completely; live GPU verification requires running daemon.
2. **Real VS Code Extension Host UI Rendering**:
   - Webview DOM interactions and ConPTY terminal visuals are tested headlessly via data contracts and provider APIs; full visual verification requires manual QA or `@vscode/test-electron`.
3. **Native Linux / macOS Execution**:
   - CI matrix (`.github/workflows/ci.yml`) is configured for multi-OS, but current engineering workstation is Windows 11.
4. **Live Swarm Multi-Agent Token Throughput against Active GPU**:
   - Verified via deterministic simulated transcript replay; empirical token throughput requires user GPU execution.

### 2.3 Skipped Tests and Reasons
Across all 48 test suites in the codebase:
- **Unit Tests**: **0 skipped** (361 passing, 0 failing, 0 pending across 41 suites).
- **Integration Tests**: **3 pending** in `test/real-integration/liveOllama.test.ts`:
  1. `Live Ollama - Health Probe: connects and fetches tags or skips gracefully if offline`
  2. `Live Ollama - Inference: streams a simple completion or skips gracefully if offline`
  3. `Live Ollama - Error Recovery: handles non-existent model or connection drop cleanly`
  - *Reason*: Explicit `this.skip()` calls when HTTP probe to `http://127.0.0.1:11434/api/tags` fails (daemon offline).

### 2.4 Residual Risks for Phase 11 & 12
1. **Terminal vs Webview Concurrency**: Both interfaces dispatch commands to the agent. Without single-flight mutex serialization in `SessionEngine`, concurrent prompts could interleave and corrupt session state.
2. **Windows ConPTY CRLF / ANSI Handling**: Windows terminal emulation requires strict handling of `\r\n` line endings and VT100 cursor control sequences to prevent visual tearing.
3. **Session Schema v1 to v2 Migration**: Existing user session files in `.vscode/local-copilot/chat_history.json` must be migrated losslessly with corrupted JSON fallback.
4. **VRAM Exhaustion on Unbounded Context**: Sessions extending beyond 8k tokens without compaction risk spilling into system RAM, causing inference speed to collapse from ~35 t/s to ~3 t/s.

---

## 3. Baseline Verification Commands & Exact Counts

All five baseline verification commands were executed directly on the repository:

| Verification Stage | Exact Command Executed | Exit Code | Result Summary |
|-------------------|------------------------|-----------|----------------|
| **TypeScript Compile** | `npm run compile` | **0** | Clean compilation. Zero errors. |
| **Unit Test Suite** | `npm run test:unit` | **0** | **361 passing**, 0 failing, 0 pending (41 test suites, 5.0s). |
| **Real Integration Suite** | `npm run test:real` | **0** | **23 passing**, 0 failing, **3 pending** (offline mode) (7 test suites, 2.0s). |
| **Extension Prepublish** | `npm run vscode:prepublish` | **0** | Clean esbuild production bundle. Zero errors. |
| **Git Diff Quality Check** | `git diff --check` | **0** | Zero whitespace errors, zero merge conflict markers. |

**Total passing automated tests**: **384 tests** (361 unit + 23 integration).

---

## 4. Git State Inventory & Commit Plan Audit

- **Working Directory**: `c:\Projects\local-copilot-chat`
- **Current Git Branch**: `main`
- **Current HEAD Commit**: `b9c23c942b9e027ec5303a048b9099ba6e923d9d`
- **Phase 8.0 Commit Plan Status**: **NOT executed.** Zero commits created. All work from Phases 1–10 remains intact in the working tree.
- **Git Working Tree Summary**:
  - Staged changes: **0 files**
  - Tracked modified files: **17 files** (`package.json`, `package-lock.json`, `src/extension.ts`, `src/services/agentLoop.ts`, `src/services/toolRegistry.ts`, `src/services/pathSecurity.ts`, `src/services/memoryService.ts`, `src/services/modelLifecycleManager.ts`, `src/services/chatSessionManager.ts`, `src/services/auditLogger.ts`, `src/webview/sidebarProvider.ts`, `README.md`, `PLAN.md`, `IMPLEMENTATION_STATUS.md`, `TECHNICAL_DOCUMENTATION.md`, `THREAT_MODEL.md`, `CHANGELOG.md`).
  - Untracked files: **56 files** (new services, tools, unit tests, integration tests, backup artifacts, and engineering reports).
- **External Verified Backups**:
  - `C:\Projects\local-copilot-chat-phase7-backup.zip` (405 MB)
  - `C:\Projects\local-copilot-chat-phase8-backup.zip` (395 MB)

---

## 5. Design Completeness Confirmation

Every single deliverable in [`engineering/phase_11_12_design.md`](file:///c:/Projects/local-copilot-chat/engineering/phase_11_12_design.md) has been audited and confirmed to contain all seven required sections:

```
Deliverable 11.0 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.1 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.2 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.3 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.4 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.5 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.6 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.7 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.8 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 11.9 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.0 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.1 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.2 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.3 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.4 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.5 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.6 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable 12.7 -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
Deliverable DOC  -> Findings: Yes, Risks: Yes, Design: Yes, Test Plan: Yes, Criteria: Yes, Rollback: Yes, Questions: Yes
```

All closing sections are present:
- **Implementation Order** (staged dependency-driven sequence)
- **Dependency Graph** (Mermaid flowchart)
- **Items to Defer or Cut** (dynamic numCtx, dual-model speculative decoding, native node-pty C-bindings, cloud telemetry)
- **Results that Require User GPU or Approval** (live GPU benchmark sweep, `/tune` sweep, model downloads)
- **Honest List of Items Unlikely to Yield Measurable Gains on 8 GB VRAM** (dynamic context reloads, concurrent models, draft models)

---

## 6. Model Inventory & Proposed Benchmark Strategy

An inspection of local Ollama model manifests and disk blobs at `C:\Users\Sagar\.ollama\models\` reveals the following installed models:

| Model Tag | Disk Blob Size | Parameters | Quantization | VRAM Profile (8 GB Budget) | Suitability / Role |
|-----------|----------------|------------|--------------|-----------------------------|---------------------|
| **`qwen2.5-coder:7b`** | **4.36 GB** | 7.6B | Q4_K_M | **High Headroom**: Leaves ~3.6 GB for 8k–16k KV cache context without RAM offload. | **Primary Baseline Coding Model.** Fast token throughput (~35–45 t/s), excellent code generation and tool calling. |
| **`deepseek-r1:8b`** | **4.87 GB** | 8.0B | Q4_K_M | **Medium Headroom**: Leaves ~3.1 GB for 8k KV cache context. | **Reasoning Model.** Strong chain-of-thought `<think>` logic; higher latency per response. |
| **`qwen3.5:9b`** | **6.10 GB** | 9.0B | Standard | **Tightly Constrained**: Leaves ~1.9 GB; context window must be limited to 4096 to prevent CPU spillover. | **High-Capacity Evaluator.** Useful for complex refactoring benchmarks if context is bounded. |
| **`nomic-embed-text:latest`** | **0.26 GB** | 137M | F16 | Minimal (260 MB). | **Vector Embeddings.** Not evaluated as a chat/coding agent. |

### Ollama Daemon Status:
- HTTP probe to `http://127.0.0.1:11434/api/tags` returned `ECONNREFUSED` (daemon is currently offline).
- The Phase 12-Prep implementation (`12.0` and `12.1`) will build offline deterministic test harnesses and mock providers so that all automated tests pass with 100% reliability offline, while automatically detecting and utilizing the live daemon when online.

### Proposed Initial Benchmark Model:
Once Deliverables `12.0` (Hardware Fingerprinting) and `12.1` (Model-Parametric Benchmark Harness) are implemented:
1. **Primary Model**: Benchmark **`qwen2.5-coder:7b`** across the 30-task corpus to establish the empirical latency (TTFT, tokens/sec), memory footprint, and pass rate baseline.
2. **Comparison Model**: Benchmark **`deepseek-r1:8b`** against the same tasks to measure reasoning-vs-speed trade-offs on 8 GB VRAM.
