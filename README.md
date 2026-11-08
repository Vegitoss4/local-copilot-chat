# Local Copilot Chat

Local Copilot Chat is a privacy-first, local autonomous AI coding assistant extension for Visual Studio Code. Powered entirely by [Ollama](https://ollama.com), it runs completely on your local workstation without sending proprietary source code or credentials to external cloud APIs.

Designed and hardened specifically for **8 GB VRAM developer GPUs** (such as NVIDIA RTX 3050/3060/4060 or Apple Silicon unified memory), Local Copilot Chat delivers agentic coding, multi-file refactoring, autonomous debugging, and swarm intelligence with strict resource boundaries.

---

## Key Capabilities

- **Hierarchical Swarm Architecture**: Multi-agent orchestration featuring specialized roles:
  - 🧠 **Architect**: Analyzes workspace symbols, computes caller impacts, and synthesizes structured execution plans (`PlanSchemaV1`).
  - 🧑‍💻 **Developer**: Applies multi-strategy code generation (exact `str_replace`, whitespace-normalized matching, and anchor-based block replacement).
  - 🔬 **Tester**: Executes real unit tests and builds with deterministic test-weakening prevention (`.skip`, `xit` rejection).
  - 📋 **Reviewer**: Evaluates code quality, verifies pre-checks, and prunes hallucinated line references.
  - 🛡️ **Security Auditor**: Detects credential leaks, blocks sensitive target modifications, and neutralizes prompt injections.
- **Hardware-Constrained 8 GB VRAM Budget**:
  - `HardwareCapacityManager` serializes all LLM inference turns in a strict FIFO queue.
  - Guarantees strictly single-model GPU residency to prevent VRAM overflow or GPU swapping on 7B–9B models (`qwen2.5-coder:7b`, `deepseek-r1:8b`).
  - Allows background tool execution (builds, tests, file scanning) to run concurrently with inference.
- **Robust Tolerant JSON Parser**:
  - Automatically recovers and repairs common local LLM syntax quirks: markdown code fences, trailing commas, unquoted keys, single quotes, and truncated bracket balance.
- **Autonomous Debugging (`/fix`)**:
  - Captures compiler errors, stack traces, and test assertion failures, localizes culprits via `PathSecurity`, and transactionally applies verified surgical fixes with automatic rollback.
- **Standardized Benchmark Harness (`/benchmark`)**:
  - Comprehensive 30-task benchmark corpus spanning code repair, feature generation, refactoring, and tool use with delta metrics tracking across model iterations.
- **Low-Token Incremental Repository Map**:
  - In-process TypeScript Compiler AST and degree-centrality ranking with `.vscode/local-copilot/repo-map.json` atomic disk caching.
- **Workspace Conflict Resolution**:
  - Shared read leases and exclusive write leases with 30s TTL expiry and canonical alphabetical acquisition to eliminate deadlocks.
- **Adversarial Prompt Defense**:
  - Isolates untrusted workspace code in `<untrusted_content>` tags.
  - Neutralizes role-spoofing tags (`<system>`), instruction overrides, and jailbreak phrases.

---

## Recommended Models

| Model | Size | Primary Role |
|---|---|---|
| `qwen2.5-coder:7b` | ~4.7 GB VRAM | Fast, surgical code generation, editing, and tool execution |
| `deepseek-r1:8b` | ~4.9 GB VRAM | Deep reasoning, root-cause defect analysis, and architecture planning |
| `nomic-embed-text` | CPU memory | Optional lexical and semantic RAG indexing |

---

## Security Architecture

1. **Path Security Containment**:
   - Centralized boundary validation enforcing path traversal prevention, symlink/junction canonicalization, null-byte rejection, and UNC path blocks.
2. **4-Tier Command Classification**:
   - Tier 1: Safe read-only inspection (`git status`, `git diff`)
   - Tier 2: Safe build and test runners (`npm test`, `dotnet build`)
   - Tier 3: Arbitrary terminal commands (unconditionally requiring host modal approval)
   - Tier 4: Prohibited dangerous commands (`curl`, `wget`, `rm -rf /`, `mkfs`) blocked outright.
3. **Workspace Trust Integration**:
   - Command execution and file modifications are completely disabled in untrusted workspaces.
4. **Defense-in-Depth for Sensitive Targets**:
   - Modifications targeting `.git/`, `.github/`, `.env*`, `.npmrc`, `.pypirc`, or root build scripts require explicit human-in-the-loop modal confirmation.

---

## Extension Settings

Configure via VS Code Settings (`localCopilot.*`):
- `localCopilot.ollamaEndpoint`: URL of the Ollama server (default `http://127.0.0.1:11434`).
- `localCopilot.defaultModel`: Default model for chat and editing (default `qwen2.5-coder:7b`).
- `localCopilot.temperature`: LLM sampling temperature (clamped $\le 0.1$ for tool use).
- `localCopilot.numCtx`: Context window size (default `16384`).
- `localCopilot.modelUnloadPolicy`: Model residency lifecycle policy (`keepAlive`, `unloadImmediately`, `unloadOnIdle`).
- `localCopilot.agent.enableStructuredEditFallback`: Enable structured-edit fallback protocol (CREATE, SEARCH/REPLACE, DELETE_FILE) for models that lack native tool-calling support in Ollama (default `true`).
- `localCopilot.agent.suggestAgentModeOnEditIntent`: Display a visible non-modal suggestion banner to switch to Agent Mode when edit intent is detected in Chat Mode (default `true`).
- `localCopilot.agent.minExplorationBeforeAsk`: Minimum distinct read-only exploration calls required before `ask_user` gate permits clarification questions (default `3`).
- `localCopilot.agent.maxClarificationQuestionsPerTask`: Maximum clarification questions permitted per agent task session (default `2`).
- `localCopilot.agent.enableWorkspaceDiscoveryPreStep`: Run bounded deterministic workspace discovery (file tree, tech stacks, manifests, git status) before the first agent planning turn (default `true`).
- `localCopilot.tools.stream`: Enable streaming tool calls for low Time-to-First-Byte (TTFB) responsiveness (~25-60ms) and progressive thinking progress (default `true`).
- `localCopilot.tools.enableEmbeddedFallback`: Allow strict single-call embedded tool extraction fallback only for models probed as embedded-style when native tool calls are empty (default `false`, User-scoped only via application scope; requires host modal confirmation).
- `localCopilot.timeouts.headersTimeoutMs`: Timeout in milliseconds for receiving HTTP response headers / first byte from Ollama (default `45000`, derived from cold model load + prompt eval + queue margin).

---

## Verification & Test Suite

- **Unit Tests**: **559 passing** across 56 suites (Mocha/Chai, 100% offline mocked VS Code extension host).
- **Real Integration Tests**: **34 passing** across 9 suites (validating real filesystem atomic writes, symlinks, junctions, timeouts, live Ollama, and fence sanitization).
- **Real VS Code Extension Host Tests**: **6 passing** in real `@vscode/test-electron` host verifying `openTextDocument`, `applyEdit`, `document.save`, CRLF/BOM preservation, and modal approval rejection.
- **TypeScript Compilation**: Exit code 0 (strict mode: `tsc -p ./` and `tsc -p ./tsconfig.test.json`).
- **Prepublish Packaging**: Verified via `npm run vscode:prepublish`.

> [!NOTE]
> **Harness Metric Invalidation Notice**: Earlier smoke run and 4-condition ablation write/outcome metrics were invalidated due to two test harness defects (unbridged mock `openTextDocument` and mock `save()` saving a stale closure copy). All file write operations are now verified in the real `@vscode/test-electron` extension host and validated with positive compiler controls (`dotnet build`). `firstTurnAsk` rate remains valid across all runs as it is evaluated prior to write actions.

---

## License & Permitted Usage

This project is licensed under the **PolyForm Noncommercial License 1.0.0** ([`LICENSE`](file:///c:/Projects/local-copilot-chat/LICENSE)).

- **Permitted (Noncommercial & Personal Uses)**:
  - Personal study, learning, hobby projects, private home use, amateur pursuits, and experimentation.
  - Noncommercial organizations: educational institutions, public research organizations, and non-profit public health/safety entities.
- **Prohibited (Commercial & Company Uses)**:
  - Any commercial purpose or use in connection with a for-profit business, company, or corporate deployment.
  - Selling, sublicensing, or providing hosted commercial services/SaaS based on this software.
  - Any company or business use requires an explicit separate commercial license from the author.
