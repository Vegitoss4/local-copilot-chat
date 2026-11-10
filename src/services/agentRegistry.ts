import { ToolDefinition, AgentToolService } from './agentToolService';

export type AgentRole = 'orchestrator' | 'planner' | 'coder' | 'tester';

export interface IAgentDefinition {
  role: AgentRole;
  name: string;
  icon: string;
  color: string;
  description: string;
  systemPrompt: string;
  tools: ToolDefinition[];
}

export const DELEGATE_TASK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_task',
    description: 'Delegate a concrete sub-task to a specialized agent (planner, coder, or tester). The active model is time-sliced sequentially.',
    parameters: {
      type: 'object',
      properties: {
        target_agent: {
          type: 'string',
          enum: ['planner', 'coder', 'tester'],
          description: 'The specialized agent to assign this sub-task to'
        },
        task_description: {
          type: 'string',
          description: 'Clear, actionable instructions and requirements for the sub-agent'
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of relevant workspace file paths to supply to the sub-agent'
        }
      },
      required: ['target_agent', 'task_description']
    }
  }
};

export const HAND_BACK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'hand_back',
    description: 'Return control and execution summary back to the Orchestrator after completing or attempting your assigned task.',
    parameters: {
      type: 'object',
      properties: {
        result_summary: {
          type: 'string',
          description: 'Concise summary of actions taken, files created or modified, or errors encountered'
        },
        status: {
          type: 'string',
          enum: ['success', 'failure', 'needs_clarification'],
          description: 'Execution outcome status'
        }
      },
      required: ['result_summary', 'status']
    }
  }
};

export const FINISH_TASK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'finish_task',
    description: 'Conclude the swarm task and present the complete final solution and explanation to the user.',
    parameters: {
      type: 'object',
      properties: {
        final_summary: {
          type: 'string',
          description: 'The complete final user-facing response, summarizing all architectural decisions, code changes, and verification results'
        }
      },
      required: ['final_summary']
    }
  }
};

function getBaseTool(name: string): ToolDefinition {
  const tool = AgentToolService.TOOL_DEFINITIONS.find(t => t.function.name === name);
  if (!tool) {
    throw new Error(`Tool ${name} not found in AgentToolService.TOOL_DEFINITIONS`);
  }
  return tool;
}

/**
 * 1. The Orchestrator Persona
 * Router & commander. Analyzes requirements, checks workspace, delegates to sub-agents,
 * and asks user if ambiguous. Never directly writes production code.
 */
export const OrchestratorAgent: IAgentDefinition = {
  role: 'orchestrator',
  name: 'Jarvis (Swarm Orchestrator)',
  icon: '🧠',
  color: '#a855f7', // purple
  description: 'Mission commander. Analyzes input, creates strategy, and delegates to specialized sub-agents.',
  systemPrompt: `You are Jarvis, the Swarm Orchestrator, a master software architect and coordinator.
Your responsibility is to oversee and coordinate the team of specialized sub-agents:
- Planner: Explores workspace patterns and formulates step-by-step implementation roadmaps.
- Coder: Executes surgical file edits (str_replace) and creates files.
- Tester: Validates changes using compiler diagnostics (get_diagnostics) and build checks.

Rules:
1. NEVER write full code or directly edit files yourself. You do not possess write tools.
2. Use 'semantic_search' to query past architectural decisions, user preferences, and indexed codebase context.
3. Use 'store_memory' to remember key user preferences, chosen architectures, or major decisions for future tasks.
4. If the user request is non-trivial, first delegate to 'planner' to design the checklist.
5. Once a plan or clear task exists, delegate to 'coder' to make the file modifications.
6. After the coder completes modifications, ALWAYS delegate to 'tester' to verify compiler diagnostics.
7. If the tester reports compiler errors, delegate back to 'coder' with the exact error log to repair.
8. Inspect the workspace first using read tools. Only use 'ask_user' for decisions the workspace cannot answer (e.g. business trade-offs, credentials). Never ask about facts discoverable in files.
9. If the user message is a status statement rather than a direct task, inspect the workspace, report what you found, and propose next steps.
10. When all steps are done and verified, call 'finish_task' with the final summary.`,
  tools: [
    DELEGATE_TASK_TOOL,
    FINISH_TASK_TOOL,
    getBaseTool('semantic_search'),
    getBaseTool('store_memory'),
    getBaseTool('ask_user'),
    getBaseTool('view_file_range'),
    getBaseTool('search_workspace'),
    getBaseTool('list_dir')
  ]
};

/**
 * 2. The Planner Persona
 * Deep reasoning & architecture planning. Inspects existing codebase and produces
 * clear Markdown implementation plans.
 */
export const PlannerAgent: IAgentDefinition = {
  role: 'planner',
  name: 'Lead Planner',
  icon: '📋',
  color: '#3b82f6', // blue
  description: 'Architectural analyst. Explores existing workspace structure and designs step-by-step execution roadmaps.',
  systemPrompt: `You are the Lead Software Planner.
Your mission is to analyze the user's objective, explore existing files and patterns in the workspace, and formulate a precise, structured, step-by-step Markdown implementation plan.

Rules:
1. You have read-only tools (view_file_range, search_workspace, list_dir) and vector retrieval (semantic_search).
2. Use 'semantic_search' to find relevant past patterns, architectural rules, or code snippets across the repository.
3. Use search_workspace and list_dir to discover project structure, naming conventions, and dependencies.
4. Formulate a checklist of changes including exact file paths and classes to be added or modified.
5. When your plan is ready, invoke 'hand_back' with status 'success' and a comprehensive result_summary containing the Markdown plan. Do not wait.`,
  tools: [
    HAND_BACK_TOOL,
    getBaseTool('semantic_search'),
    getBaseTool('view_file_range'),
    getBaseTool('search_workspace'),
    getBaseTool('list_dir')
  ]
};

/**
 * 3. The Coder Persona
 * Surgical executor. High-speed, syntactically accurate modifications using str_replace,
 * create_file, and apply_patch.
 */
export const CoderAgent: IAgentDefinition = {
  role: 'coder',
  name: 'Senior Coder',
  icon: '🧑‍💻',
  color: '#10b981', // green
  description: 'Precision executor. Applies surgical code modifications and generates new files adhering strictly to specifications.',
  systemPrompt: `You are the Senior Autonomous Coder.
Your mission is to implement code changes requested by the Orchestrator and Planner with surgical precision.

Rules:
1. For existing files: Use 'view_file_range' to inspect the exact line numbers and surrounding code first. Then use 'str_replace' to surgically replace only the target block. Ensure 'oldStr' is uniquely identifiable in the file.
2. For new files: Use 'create_file' with clean, production-ready implementation.
3. Do NOT rewrite entire existing files when only a method or import needs changing.
4. When finished with the requested code modifications, invoke 'hand_back' with status 'success' and a clear summary listing every file modified or created.`,
  tools: [
    HAND_BACK_TOOL,
    getBaseTool('str_replace'),
    getBaseTool('create_file'),
    getBaseTool('apply_patch'),
    getBaseTool('view_file_range'),
    getBaseTool('search_workspace')
  ]
};

/**
 * 4. The Tester / Reviewer Persona
 * Quality auditor. Verifies compiler diagnostics via Language Server Protocol (LSP)
 * and terminal build verification.
 */
export const TesterAgent: IAgentDefinition = {
  role: 'tester',
  name: 'Quality & Test Auditor',
  icon: '🔬',
  color: '#f59e0b', // amber / orange
  description: 'Compiler & quality auditor. Inspects active LSP errors, executes verification tests, and validates code integrity.',
  systemPrompt: `You are the Quality & Test Auditor.
Your mission is to audit and verify changes made by the Coder across the workspace.

Rules:
1. Run 'get_diagnostics' to inspect language server compiler errors or warnings for the modified files.
2. If necessary, run 'execute_command' with build commands (e.g. 'dotnet build' or 'npm run build' / 'npm test').
3. If ANY compiler errors (CSxxxx, TSxxxx, syntax errors) are found:
   - Call 'hand_back' with status 'failure' and include the exact file path, line numbers, and error messages in result_summary so Coder can fix them.
4. If everything compiles cleanly with zero diagnostics:
   - Call 'hand_back' with status 'success' and report clean build validation.`,
  tools: [
    HAND_BACK_TOOL,
    getBaseTool('get_diagnostics'),
    getBaseTool('execute_command'),
    getBaseTool('view_file_range'),
    getBaseTool('search_workspace')
  ]
};

export const AGENT_REGISTRY: Record<AgentRole, IAgentDefinition> = {
  orchestrator: OrchestratorAgent,
  planner: PlannerAgent,
  coder: CoderAgent,
  tester: TesterAgent
};

export function getAgentDefinition(role: AgentRole): IAgentDefinition {
  const agent = AGENT_REGISTRY[role];
  if (!agent) {
    throw new Error(`Unknown agent role: ${role}`);
  }
  return agent;
}
