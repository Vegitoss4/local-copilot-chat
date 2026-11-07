# Phase 5.5 H4 Technical Specification: Operational Hardening & Resilience

**Milestone:** Phase 5.5 H4  
**Status:** ARCHITECTURE AUDIT & TECHNICAL SPECIFICATION (AWAITING USER APPROVAL)  
**Authors:** Developer + Principal Architect  
**Target Branch:** `main` (Working-tree only; 0 Git commits)  
**Hardware & Environment Constraints:** Local-first, offline-capable, 8 GB VRAM budget, Ollama runtime  

---

## 1. Executive Summary & Audit Findings

During the Phase 5.5 H4 architecture audit across [`src/services/ollamaService.ts`](file:///c:/Projects/local-copilot-chat/src/services/ollamaService.ts), [`src/providers/chatViewProvider.ts`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts), [`src/services/memoryService.ts`](file:///c:/Projects/local-copilot-chat/src/services/memoryService.ts), [`src/services/swarmOrchestrator.ts`](file:///c:/Projects/local-copilot-chat/src/services/swarmOrchestrator.ts), and [`src/services/agentToolService.ts`](file:///c:/Projects/local-copilot-chat/src/services/agentToolService.ts), four critical operational vulnerabilities were identified:

1. **Unbounded Network Calls & Stalled Stream Deadlocks ([`ollamaService.ts:40`](file:///c:/Projects/local-copilot-chat/src/services/ollamaService.ts#L40), [`ollamaService.ts:75`](file:///c:/Projects/local-copilot-chat/src/services/ollamaService.ts#L75))**:
   - `fetch(`${this.endpoint}/api/tags`)` has no connect timeout or abort signal. If Ollama daemon is hung or endpoint is unreachable, the request blocks indefinitely.
   - `streamChat` accepts an `AbortSignal` for user cancellation, but lacks an **idle-stream timeout**. If Ollama halts or drops packets mid-stream without terminating the HTTP chunked transfer, `reader.read()` deadlocks indefinitely.
   - `chatWithTools` has no request/header timeout.
2. **Unmanaged VRAM Footprint Under 8 GB Hardware Constraints ([`ollamaService.ts:198`](file:///c:/Projects/local-copilot-chat/src/services/ollamaService.ts#L198))**:
   - The current `unloadModel` helper issues `POST /api/generate` with `{ keep_alive: 0 }`, but the extension has no tracking of which model is currently occupying memory, no idle unload timer, and no user-configurable unload policy.
   - Sequential execution of a 9B reasoning model (DeepSeek-R1) and a 7B coding model (Qwen2.5-Coder) without explicit VRAM unloading can cause Ollama to exceed 8 GB GPU VRAM and fall back to CPU offloading or trigger out-of-memory errors.
3. **Multi-Root State Bleeding & Arbitrary Root Assumptions ([`chatViewProvider.ts:544`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L544), [`memoryService.ts:54`](file:///c:/Projects/local-copilot-chat/src/services/memoryService.ts#L54), [`swarmOrchestrator.ts:927`](file:///c:/Projects/local-copilot-chat/src/services/swarmOrchestrator.ts#L927))**:
   - All persistence routines hardcode `vscode.workspace.workspaceFolders[0].uri`. In multi-root workspaces (`.code-workspace`), tasks targeting Folder B save their history, memory chunks, and whiteboard state into Folder A's `.vscode/local-copilot/` directory.
   - Simply replacing `workspaceFolders[0]` with an arbitrary root is insufficient; conversation sessions, memory indices, and whiteboard tasks must be deterministically bound to their target workspace root and preserved across editor focus changes.
4. **Shared Infrastructure Cohesion (Cross-Cutting Concern)**:
   - H4.1 (timeouts/cancellation) and H4.2 (model lifecycle) must share a unified request and abort abstraction (`fetchWithLifecycle`) to prevent competing abort signals, race conditions, or uncoordinated unload calls while a generation is in flight.

---

## 2. H4 Architecture Audit & Deep Dive

### 2.1 H4.1 — Ollama Resilience and Request Lifecycle

#### Current Behavior
- In [`src/services/ollamaService.ts`](file:///c:/Projects/local-copilot-chat/src/services/ollamaService.ts):
  - `getAvailableModels()`: Calls raw `fetch(`${this.endpoint}/api/tags`)`. No timeouts.
  - `streamChat()`: Accepts `signal?: AbortSignal`. Reads bytes from `response.body.getReader()`. If Ollama crashes or hangs without closing the stream, the loop `while (true) { const { done, value } = await reader.read(); }` hangs forever.
  - `chatWithTools()`: Calls `fetch(`${this.endpoint}/api/chat`, { signal })` with no timeout.
- In [`src/providers/chatViewProvider.ts`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts):
  - `stopGeneration()` aborts `_currentAbortController`. If generation was stalled in a socket read that never yields, user cancellation works, but automatic timeout recovery is completely missing.

#### The Four Independent Timeout Tiers
To prevent arbitrary monolithic timeouts from failing cold-start model loads, the timeout architecture must independently govern 4 distinct phases:

```
[Request Initiated]
        │
        ├── 1. Connect Timeout (e.g. 5s)
        │      (TCP handshake & initial socket connection)
        ▼
[Socket Connected]
        │
        ├── 2. TTFB / Headers Timeout (e.g. 15s warm, 60s cold-start)
        │      (Ollama processing prompt or loading weights from NVMe into VRAM)
        ▼
[HTTP 200 OK & Stream Opened]
        │
        ├── 3. Stream Inactivity / Idle Timeout (e.g. 30s)
        │      (Timer resets on EVERY received chunk; triggers if stream halts)
        ▼
[Stream Transfer Active]
        │
        └── 4. Total Generation Timeout (e.g. 180s - 300s)
               (Hard global ceiling for entire generation turn)
```

1. **Connection Establishment Timeout (`connectTimeoutMs`, default 5,000ms)**:
   - Governs socket creation and initial TCP connect to Ollama.
   - Fast fail if Ollama daemon is offline or port is closed.
2. **Response Headers / TTFB Timeout (`headersTimeoutMs`, default 45,000ms)**:
   - The period between request transmission and the receipt of HTTP headers.
   - Must be generous enough to allow Ollama to load model weights from disk to GPU on the first turn without prematurely timing out.
3. **Stream Inactivity / Idle Timeout (`idleStreamTimeoutMs`, default 30,000ms)**:
   - In `streamChat`, a sliding deadline timer is reset upon *every incoming token chunk*.
   - If Ollama GPU process stalls, deadlocks, or the TCP link is silently dropped, this triggers after 30s of zero chunks, aborting the stream reader and freeing the UI.
4. **Total Generation Timeout (`totalTimeoutMs`, default 300,000ms / 5 minutes)**:
   - Absolute backstop preventing infinite runaways during long multi-file agent tool iterations.

#### Cancellation & Cleanup Race Guarantees
- **Unified Abort Coordination**: When an idle timeout or total timeout fires, an internal `TimeoutAbortController` aborts with a typed `OllamaTimeoutError(kind: 'connect' | 'headers' | 'idle' | 'total')`.
- **User Stop vs. Timeout Race**: If user clicks "Stop" at the exact instant a timeout fires:
  - Both signal the underlying fetch reader.
  - `ChatViewProvider`'s generation lock release is strictly owned by `_currentGenerationId === generationId` in its `finally` block.
  - Exactly one terminal event (`streamAborted` or `streamError`) is dispatched to the webview. Duplicate messages are suppressed.
- **Leaked Timer Defense**: All sliding idle timers and overall timeout handles are registered in a cleanup set and unconditionally cleared in `finally` blocks.

---

### 2.2 H4.2 — Model Lifecycle and VRAM Management

#### How Ollama's `keep_alive` Actually Behaves
Research and validation against the Ollama HTTP API confirm:
1. **Request Body Parameter (`keep_alive`)**:
   - Supported in `POST /api/chat` and `POST /api/generate`.
   - Accepts duration strings (e.g., `"5m"`, `"10m"`, `"0"`, `"-1"`).
   - If `keep_alive: 0` is passed, Ollama unloads the model immediately after emitting the response.
   - If `keep_alive: -1`, Ollama pins the model in VRAM indefinitely.
   - Default is `"5m"` (unloads 5 minutes after last request).
2. **Explicit Unload via `POST /api/generate`**:
   - Calling `POST /api/generate` with `{ "model": "qwen2.5-coder:7b", "keep_alive": 0 }` triggers immediate release of GPU memory.
3. **Real Loaded-Model State via `GET /api/ps`**:
   - Ollama exposes `GET /api/ps` returning currently running models:
     ```json
     {
       "models": [
         {
           "name": "qwen2.5-coder:7b",
           "model": "qwen2.5-coder:7b",
           "size": 4683073984,
           "size_vram": 4683073984,
           "expires_at": "2026-11-07T00:30:00Z"
         }
       ]
     }
     ```
   - This provides **ground-truth observability**. The extension does not need to guess or simulate VRAM numbers; it queries `/api/ps` when inspecting loaded state.

#### Avoiding False VRAM Assumptions
- **Distinction**: The extension tracks **desired state** (what model we requested) and **observed state** (what Ollama reports via `/api/ps`).
- The extension does **not** assume full control over host GPU memory (Ollama may share VRAM with other host processes or OS graphics drivers). It never attempts raw CUDA memory arithmetic.
- Instead, the extension enforces safe **lifecycle transitions** to prevent Ollama from attempting to pack two 7B–9B models into 8 GB VRAM simultaneously.

#### Configurable Model Unload Policies
Exposed via VS Code settings (`package.json`):
- `localCopilot.modelUnloadPolicy`:
  - `"keepAlive"` (default): Relies on Ollama's built-in `keep_alive` duration (`localCopilot.modelKeepAliveDuration`, default `"5m"`).
  - `"unloadImmediately"`: Automatically passes `keep_alive: 0` on every chat/generate request. Ideal for users sharing GPU with other applications or running close to 8 GB limits.
  - `"unloadOnIdle"`: The extension runs an idle timer (e.g. 3 minutes of no chat activity in the UI). When the timer expires and no generation is active, it calls `POST /api/generate` with `keep_alive: 0`.

---

### 2.3 H4.3 — Multi-Root Workspace Isolation

#### Current Vulnerability Analysis
- In [`src/providers/chatViewProvider.ts:544-547`](file:///c:/Projects/local-copilot-chat/src/providers/chatViewProvider.ts#L544-L547):
  ```typescript
  private _getHistoryFileUri(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'local-copilot', 'chat_history.json');
  }
  ```
- In [`src/services/memoryService.ts:54-62`](file:///c:/Projects/local-copilot-chat/src/services/memoryService.ts#L54-L62):
  ```typescript
  const rootUri = folders[0].uri;
  this.memoryDirUri = vscode.Uri.joinPath(rootUri, '.vscode', 'local-copilot');
  this.memoryFileUri = vscode.Uri.joinPath(this.memoryDirUri, 'memory.json');
  ```
- In [`src/services/swarmOrchestrator.ts:927-929`](file:///c:/Projects/local-copilot-chat/src/services/swarmOrchestrator.ts#L927-L929):
  ```typescript
  return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'local-copilot', 'whiteboard.json');
  ```
- In [`src/services/workspaceService.ts:66`](file:///c:/Projects/local-copilot-chat/src/services/workspaceService.ts#L66):
  ```typescript
  const rootFolder = folders[0];
  ```

#### Multi-Root Resolution Architecture
In a multi-root workspace (`.code-workspace`), folders can be added, removed, or reordered dynamically. To avoid arbitrary root selection:

1. **Active Root Determination Algorithm**:
   ```
   function resolveTargetWorkspaceRoot(preferredUri?: vscode.Uri): vscode.WorkspaceFolder {
     1. If a preferredUri is passed (e.g. explicitly set by session), resolve via:
        vscode.workspace.getWorkspaceFolder(preferredUri).
     2. Else if an active text editor is visible:
        vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri).
     3. Else if a previous session root was remembered and is still in workspaceFolders:
        use that folder.
     4. Else:
        fallback to workspaceFolders[0].
   }
   ```
2. **Turn-Level Root Binding**:
   - When a user sends a prompt, the active target root is resolved and stored in the turn context (`sessionRootUri`).
   - The entire turn (chat streaming, RAG memory retrieval, tool executions, whiteboard updates, history persistence) is pinned to this `sessionRootUri`.
   - Switching active tabs in VS Code while a generation or agent task is executing **cannot** alter the running turn's root.
3. **Workspace Folder Identity & Storage Strategy**:
   - Each workspace folder maintains its own isolated `.vscode/local-copilot/` directory:
     - `FolderA/.vscode/local-copilot/{chat_history.json, whiteboard.json, memory.json}`
     - `FolderB/.vscode/local-copilot/{chat_history.json, whiteboard.json, memory.json}`
   - **No Cross-Project Contamination**: Vector memory search (`MemoryService.retrieveRelevantChunks`) filters exclusively to the chunks indexed from the active workspace folder.
4. **UI Workspace Folder Selector**:
   - When `vscode.workspace.workspaceFolders.length > 1`, the webview header displays an active workspace folder picker pill (e.g., `📁 frontend [▾]`).
   - The user can explicitly select which folder the chat or agent operates against, or leave it on `(Auto: active file)`.
5. **Safe Migration from Single-Root**:
   - If single-root workspace is converted to multi-root, existing `.vscode/local-copilot/` files inside the original root remain completely valid and intact. No data is lost or moved.

---

### 2.4 Cross-Cutting Infrastructure: Shared Request & Cancellation Engine

To ensure H4.1 and H4.2 do not implement competing timeout, abort, or lifecycle mechanisms, a unified internal helper is introduced in `OllamaService`:

```typescript
export interface RequestLifecycleOptions {
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  idleStreamTimeoutMs?: number;
  totalTimeoutMs?: number;
  parentSignal?: AbortSignal;
}
```

- Both `streamChat` (H4.1) and `chatWithTools` (H4.1) use `executeStreamWithLifecycle` and `executeJsonWithLifecycle`.
- `unloadModel` (H4.2) and `getLoadedModels` (H4.2) use `executeJsonWithLifecycle` with dedicated short connect/header timeouts (e.g. 5s/10s).
- **Concurrency Serialization**:
  - `OllamaService` maintains an internal `_isGenerationActive` flag.
  - An idle unload timer from H4.2 will never dispatch an `unloadModel` call if `_isGenerationActive === true`.
  - Conversely, model switching operations await completion/abort of active generation before sending unload/load commands.

---

## 3. Detailed Component Designs & Interfaces

### 3.1 `OllamaService` Timeout & Lifecycle Extensions (`src/services/ollamaService.ts`)

```typescript
export interface IOllamaModelInfo {
  name: string;
  model: string;
  size: number;
  sizeVram?: number;
  expiresAt?: string;
}

export class OllamaTimeoutError extends Error {
  constructor(
    public readonly phase: 'connect' | 'headers' | 'idle_stream' | 'total',
    public readonly timeoutMs: number,
    message?: string
  ) {
    super(message || `Ollama request timed out during ${phase} phase after ${timeoutMs}ms.`);
    this.name = 'OllamaTimeoutError';
  }
}
```

New methods to add to `OllamaService`:
- `public async getLoadedModels(): Promise<IOllamaModelInfo[]>`: Queries `GET /api/ps`.
- `public async ping(timeoutMs?: number): Promise<boolean>`: Quick connection health probe.
- `public cancelActiveRequests(): void`: Programmatic abort for all in-flight requests on extension deactivation or workspace switch.

### 3.2 Configuration Contributions (`package.json`, `src/services/configurationService.ts`)

New configuration properties in `package.json`:
1. `localCopilot.connectTimeout`: integer, default `5000` ms, bounds [1000, 30000].
2. `localCopilot.idleStreamTimeout`: integer, default `30000` ms, bounds [5000, 120000].
3. `localCopilot.totalGenerationTimeout`: integer, default `300000` ms, bounds [30000, 900000].
4. `localCopilot.modelUnloadPolicy`: string enum `["keepAlive", "unloadImmediately", "unloadOnIdle"]`, default `"keepAlive"`.
5. `localCopilot.modelKeepAliveDuration`: string, default `"5m"`.
6. `localCopilot.idleUnloadTimeout`: integer, default `180000` ms (3 minutes), bounds [30000, 600000].

### 3.3 Workspace Manager Helper (`src/services/workspaceManager.ts`)

Introduce a dedicated service to encapsulate multi-root resolution, eliminating duplication:
```typescript
export class WorkspaceManager {
  public static getActiveFolder(preferredUri?: vscode.Uri): vscode.WorkspaceFolder | null;
  public static getStorageUri(folder: vscode.WorkspaceFolder, subPath?: string): vscode.Uri;
  public static resolveFileToFolder(fileUri: vscode.Uri): vscode.WorkspaceFolder | null;
}
```

---

## 4. State Machines

### 4.1 Request & Stream Inactivity State Machine (H4.1)

```
        [START REQUEST]
               │
      (connect timer armed: 5s)
               ▼
       [CONNECTING SOCKET]
        ├─── Connect Timeout Exceeded ───► [Abort Socket & Emit OllamaTimeoutError('connect')]
        │
     (Socket Connected; headers timer armed: 45s)
        ▼
     [AWAITING HEADERS / MODEL LOAD]
        ├─── Headers Timeout Exceeded ───► [Abort Request & Emit OllamaTimeoutError('headers')]
        │
     (Headers 200 OK received; stream initialized)
        ▼
     [STREAMING CHUNKS] ◄─────────────────────────┐
        │                                         │
        ├─── Chunk Received ──────────────────────┘ (Reset idle timer: 30s)
        │
        ├─── 30s Inactivity Exceeded ────► [Cancel Reader & Emit OllamaTimeoutError('idle_stream')]
        │
        ├─── User Clicks 'Stop' ─────────► [Abort Signal & Emit AbortError]
        │
        ├─── 300s Total Exceeded ────────► [Abort & Emit OllamaTimeoutError('total')]
        │
        ▼
   [STREAM COMPLETE]
        │
   (Clear all timers; release generation lock)
```

### 4.2 Model VRAM Lifecycle State Machine (H4.2)

```
                 [IDLE: No Models in Memory]
                             │
            (User sends prompt / Agent starts)
                             ▼
                 [LOADING DESIRED MODEL]
                             │
                    (Generation Active)
                             ▼
                 [GENERATING INFERENCE]
                             │
                    (Generation Ends)
                             │
     ┌───────────────────────┴────────────────────────┐
     │ Policy:                                        │ Policy:
     ▼ "unloadImmediately"                            ▼ "keepAlive" / "unloadOnIdle"
[Unload Model Immediately]               [Arm Idle Unload Timer (e.g. 3m)]
(POST /api/generate keep_alive: 0)                   │
     │                                               ├── User Sends New Prompt ──► (Disarm timer)
     ▼                                               │
[Model Evicted from GPU]                             └── Timer Expires ──────────► [Unload Model via keep_alive: 0]
```

---

## 5. Failure Handling & Concurrency Matrix

| Scenario | System Reaction | User-Facing State | History / Disk Impact |
| :--- | :--- | :--- | :--- |
| **Ollama Daemon Dead / Refusing Connection** | `connectTimeoutMs` aborts after 5s; throws `OllamaTimeoutError('connect')`. | Webview status badge turns red (`🔴 Offline`); retry banner displayed. | Zero history written; prompt draft preserved in input box. |
| **Model Weight Load Exceeds TTFB** | `headersTimeoutMs` aborts after 45s with actionable guidance to check disk speed or model size. | Error banner: `"Ollama model load timed out after 45s. Check Ollama logs."` | Zero history written; lock released. |
| **Stream Freezes Mid-Token** | `idleStreamTimeoutMs` triggers after 30s of silence; stream reader cancelled. | Partial text retained in message bubble; notice: `"[Generation stopped: Stream timed out after 30s of inactivity]"`. | Partial message sanitized and saved with timeout notice. |
| **User Stops During Stalled Stream** | User click triggers `_currentAbortController.abort()`. Reader aborts. | Webview posts `streamAborted`; UI unlocks immediately. | Prompt retained; lock released cleanly by current generation ID. |
| **Model Switch Under VRAM Budget** | Before loading Coder model, orchestrator checks if Planner model is in memory and invokes `unloadModel` with `keep_alive: 0`. | Agent timeline shows: `"Swapping reasoning model for coding model..."`. | Whiteboard preserved; VRAM freed before next load. |
| **Active Editor Switched in Multi-Root** | Generation in flight was bound to `sessionRootUri` at start. Editor focus change does not alter running turn. | Active turn continues against initial folder; UI pill reflects pinned target. | Saved into correct folder's `.vscode/local-copilot/`. |

---

## 6. Implementation Plan & File Breakdown

### Files to Add:
1. `src/services/workspaceManager.ts`: Centralized multi-root workspace resolver.
2. `test/unit/ollamaLifecycleTimeouts.test.ts`: Test suite for connect, header, idle stream, and total timeouts.
3. `test/unit/modelLifecycleVram.test.ts`: Test suite for keep-alive, unload policies, and `/api/ps` model tracking.
4. `test/unit/multiRootWorkspace.test.ts`: Test suite for multi-root workspace folder isolation, memory isolation, and root binding.

### Files to Modify:
1. `src/services/ollamaService.ts`:
   - Implement `executeWithLifecycle`, `streamChat` sliding idle timer, `getLoadedModels`, `unloadModel` enhancements.
2. `src/providers/chatViewProvider.ts`:
   - Integrate multi-root session resolution; display workspace folder indicator in webview header; handle `OllamaTimeoutError` with descriptive user notices.
3. `src/services/memoryService.ts`:
   - Accept target `vscode.WorkspaceFolder` or root URI to support multi-root isolation.
4. `src/services/swarmOrchestrator.ts`:
   - Accept target workspace folder for whiteboard persistence.
5. `src/services/workspaceService.ts`:
   - Update `getWorkspaceSummary` to accept an explicit workspace root.
6. `src/services/configurationService.ts`:
   - Add timeout and unload policy configuration options with schema bounds.
7. `package.json`:
   - Declare VS Code settings for timeouts and unload policies.
8. `test/mocks/vscodeMock.ts`:
   - Add `vscode.workspace.getWorkspaceFolder(uri)` mock support.

---

## 7. Test Strategy & Acceptance Criteria

### Unit Test Plan:
1. **Timeout Separation & Enforcement**:
   - Verify `connectTimeout` aborts immediately when socket does not open.
   - Verify `headersTimeout` aborts when headers are delayed past threshold.
   - Verify `idleStreamTimeout` resets on chunk arrivals and aborts when chunks stall for $> 30$s.
   - Verify `totalTimeout` acts as absolute backstop.
2. **Cancellation Race Immunity**:
   - Verify user abort racing with idle timeout releases lock exactly once without duplicate `streamEnd`.
3. **Model Lifecycle & VRAM Policy**:
   - Verify `"unloadImmediately"` appends `keep_alive: 0` to request payloads.
   - Verify `"unloadOnIdle"` arms a timer that fires `unloadModel` after idle period.
   - Verify `/api/ps` parsing correctly extracts loaded models and VRAM metrics.
4. **Multi-Root Isolation**:
   - Verify 2 workspace folders have distinct `chat_history.json`, `whiteboard.json`, and `memory.json`.
   - Verify `MemoryService` retrieval in Folder B does not return chunks from Folder A.
   - Verify active editor folder resolution and turn-level root binding.

### Acceptance Criteria:
- `npm run compile` and `npm run compile:test` succeed with **0 errors**.
- All existing 197 unit tests continue to pass.
- New tests for H4.1, H4.2, and H4.3 pass 100% offline.
- Total unit test count grows from 197 to $\ge 215$.

---

## 8. Implementation Sequence & Out-of-Scope Items

### Sequential Order:
1. **H4.1 — Ollama Resilience and Request Lifecycle**: Core timeout and cancellation engine.
2. **H4.2 — Model Lifecycle and VRAM Management**: Unload policies and `/api/ps` tracking.
3. **H4.3 — Multi-Root Workspace Isolation**: `WorkspaceManager` and per-root persistence.

### Explicit Out-of-Scope Items for H4:
- Direct NVIDIA/AMD GPU driver probing or raw NVML C++ bindings (all VRAM awareness relies on Ollama's official `/api/ps` endpoint).
- Cloud AI provider integrations (100% local Ollama operation strictly preserved).
- Phase 6 autonomous agent capabilities (LSP tools, benchmark harness, autonomous code editing).
