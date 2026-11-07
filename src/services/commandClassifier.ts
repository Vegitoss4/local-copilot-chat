import * as path from 'path';

export enum CommandTier {
  TIER_1_SAFE_READONLY = 1,
  TIER_2_PROJECT_EXECUTION = 2,
  TIER_3_ARBITRARY_COMMAND = 3,
  TIER_4_PROHIBITED = 4
}

export class CommandSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSyntaxError';
  }
}

export interface ParsedCommand {
  rawCommand: string;
  executable: string;
  args: string[];
}

export interface ClassificationResult {
  tier: CommandTier;
  reason: string;
  executable: string;
  args: string[];
  normalizedCommand: string;
}

export class CommandClassifier {
  /**
   * Prohibited shell metacharacters and control characters that cannot appear anywhere in command strings.
   * Includes chaining (&&, ||, ;, &), redirection (>, <, |), subshell execution ($(), `` ` ``),
   * and control characters.
   */
  private static readonly SHELL_METACHARS_REGEX = /[;&|><`$\n\r\0]/;

  /**
   * Environment variable expansion patterns (e.g. %VAR%, %PATH%).
   */
  private static readonly ENV_VAR_REGEX = /%[a-zA-Z0-9_]+%/;

  /**
   * Direct script file extensions that cannot be launched with spawn(shell: false) on Windows or pose script execution hazards.
   */
  private static readonly PROHIBITED_SCRIPT_EXTENSIONS = /\.(bat|cmd|ps1|vbs|wsf)$/i;

  /**
   * Known interactive shells whose direct invocation is strictly prohibited.
   */
  private static readonly PROHIBITED_SHELLS = new Set([
    'powershell', 'powershell.exe',
    'pwsh', 'pwsh.exe',
    'cmd', 'cmd.exe',
    'bash', 'bash.exe',
    'sh',
    'zsh',
    'wsl', 'wsl.exe'
  ]);

  /**
   * Privilege escalation tools.
   */
  private static readonly PROHIBITED_ELEVATION = new Set([
    'sudo', 'runas', 'su', 'doas', 'takeown', 'icacls', 'set-executionpolicy'
  ]);

  /**
   * Network exfiltration and arbitrary download utilities.
   */
  private static readonly PROHIBITED_NETWORK_DOWNLOADERS = new Set([
    'curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'nc', 'ncat', 'netcat', 'certutil', 'bitsadmin'
  ]);

  /**
   * Destructive system and disk utilities.
   */
  private static readonly PROHIBITED_DESTRUCTIVE_SYSTEM = new Set([
    'format', 'diskpart', 'rmdir', 'del', 'erase', 'rm', 'shutdown', 'reboot', 'init', 'dd'
  ]);

  /**
   * Process termination utilities.
   */
  private static readonly PROHIBITED_PROCESS_MANAGERS = new Set([
    'kill', 'taskkill', 'pkill', 'killall'
  ]);

  /**
   * Deterministically tokenize a command line string into an array of string tokens.
   * Rejects shell metacharacters, subshell syntax, environment variables, and unclosed quotes.
   */
  public static tokenizeCommandLine(command: string): string[] {
    if (!command || !command.trim()) {
      throw new CommandSyntaxError('Command cannot be empty.');
    }

    if (this.ENV_VAR_REGEX.test(command)) {
      throw new CommandSyntaxError('Environment variable expansion (%VAR%) is not permitted in commands.');
    }

    const match = this.SHELL_METACHARS_REGEX.exec(command);
    if (match) {
      throw new CommandSyntaxError(
        `Shell syntax and metacharacters are rejected: found '${match[0]}'. Use structured execution without shell chaining or redirection.`
      );
    }

    const tokens: string[] = [];
    let currentToken = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let hasTokenContent = false;

    for (let i = 0; i < command.length; i++) {
      const char = command[i];

      if (inSingleQuote) {
        if (char === "'") {
          inSingleQuote = false;
          hasTokenContent = true;
        } else {
          currentToken += char;
          hasTokenContent = true;
        }
      } else if (inDoubleQuote) {
        if (char === '\\' && i + 1 < command.length) {
          const nextChar = command[i + 1];
          if (nextChar === '"' || nextChar === '\\') {
            currentToken += nextChar;
            i++;
            hasTokenContent = true;
          } else {
            currentToken += char;
            hasTokenContent = true;
          }
        } else if (char === '"') {
          inDoubleQuote = false;
          hasTokenContent = true;
        } else {
          currentToken += char;
          hasTokenContent = true;
        }
      } else {
        if (char === "'") {
          inSingleQuote = true;
          hasTokenContent = true;
        } else if (char === '"') {
          inDoubleQuote = true;
          hasTokenContent = true;
        } else if (/\s/.test(char)) {
          if (hasTokenContent) {
            tokens.push(currentToken);
            currentToken = '';
            hasTokenContent = false;
          }
        } else if (char === '\\' && i + 1 < command.length) {
          const nextChar = command[i + 1];
          if (/\s/.test(nextChar) || nextChar === '"' || nextChar === "'" || nextChar === '\\') {
            currentToken += nextChar;
            i++;
            hasTokenContent = true;
          } else {
            currentToken += char;
            hasTokenContent = true;
          }
        } else {
          currentToken += char;
          hasTokenContent = true;
        }
      }
    }

    if (inSingleQuote || inDoubleQuote) {
      throw new CommandSyntaxError('Unterminated quoted string in command.');
    }

    if (hasTokenContent) {
      tokens.push(currentToken);
    }

    if (tokens.length === 0) {
      throw new CommandSyntaxError('Command cannot be empty.');
    }

    return tokens;
  }

  /**
   * Classify a command line string or pre-tokenized command into Tiers 1-4.
   */
  public static classify(input: string | string[]): ClassificationResult {
    let tokens: string[];
    if (typeof input === 'string') {
      tokens = this.tokenizeCommandLine(input);
    } else {
      if (!input || input.length === 0) {
        throw new CommandSyntaxError('Command tokens array cannot be empty.');
      }
      for (const token of input) {
        if (typeof token !== 'string') {
          throw new CommandSyntaxError('All command tokens must be strings.');
        }
        if (this.ENV_VAR_REGEX.test(token)) {
          throw new CommandSyntaxError('Environment variable expansion (%VAR%) is not permitted in tokens.');
        }
        const m = this.SHELL_METACHARS_REGEX.exec(token);
        if (m) {
          throw new CommandSyntaxError(
            `Shell syntax and metacharacters are rejected in token: found '${m[0]}'.`
          );
        }
      }
      tokens = [...input];
    }

    const rawExecutable = tokens[0];
    const executable = path.basename(rawExecutable).toLowerCase();
    const baseName = executable.replace(/\.exe$/i, '');
    const args = tokens.slice(1);
    const normalizedCommand = tokens.join(' ');

    // 1. TIER 4: Prohibited Script Extensions (.cmd, .bat, .ps1, .vbs)
    if (this.PROHIBITED_SCRIPT_EXTENSIONS.test(rawExecutable)) {
      return {
        tier: CommandTier.TIER_4_PROHIBITED,
        reason: `Direct execution of script files (${path.extname(rawExecutable)}) without a shell is prohibited.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 2. TIER 4: Prohibited Shells
    if (this.PROHIBITED_SHELLS.has(baseName) || this.PROHIBITED_SHELLS.has(executable)) {
      return {
        tier: CommandTier.TIER_4_PROHIBITED,
        reason: `Direct invocation of interactive shell '${baseName}' is prohibited.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 3. TIER 4: Privilege Escalation
    if (this.PROHIBITED_ELEVATION.has(baseName)) {
      return {
        tier: CommandTier.TIER_4_PROHIBITED,
        reason: `Privilege escalation tool '${baseName}' is prohibited.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 4. TIER 4: Network Downloaders / Exfiltration
    if (this.PROHIBITED_NETWORK_DOWNLOADERS.has(baseName)) {
      return {
        tier: CommandTier.TIER_4_PROHIBITED,
        reason: `Network exfiltration or downloader utility '${baseName}' is prohibited.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 5. TIER 4: Destructive System Utilities
    if (this.PROHIBITED_DESTRUCTIVE_SYSTEM.has(baseName)) {
      return {
        tier: CommandTier.TIER_4_PROHIBITED,
        reason: `Destructive system or deletion utility '${baseName}' is prohibited.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 6. TIER 4: Process Management
    if (this.PROHIBITED_PROCESS_MANAGERS.has(baseName)) {
      return {
        tier: CommandTier.TIER_4_PROHIBITED,
        reason: `Process termination utility '${baseName}' is prohibited.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 7. Git-specific checks
    if (baseName === 'git') {
      // Check for prohibited Git flags that alter configuration or execute external code
      for (const arg of args) {
        if (
          arg === '-c' ||
          arg.startsWith('--config') ||
          arg.startsWith('--exec-path') ||
          arg.startsWith('--upload-pack') ||
          arg === 'config'
        ) {
          return {
            tier: CommandTier.TIER_4_PROHIBITED,
            reason: `Git configuration overrides (-c, --config, config) and external exec-paths are prohibited.`,
            executable: rawExecutable,
            args,
            normalizedCommand
          };
        }
      }

      // Check Tier 1 Git commands
      const gitTier1 = this.checkGitTier1(args);
      if (gitTier1) {
        return {
          tier: CommandTier.TIER_1_SAFE_READONLY,
          reason: gitTier1,
          executable: rawExecutable,
          args,
          normalizedCommand
        };
      }

      // Any other Git commands (e.g. commit, checkout, add, push) are Tier 3
      return {
        tier: CommandTier.TIER_3_ARBITRARY_COMMAND,
        reason: `Git operation '${args[0] || 'unknown'}' modifies repository state and requires explicit approval.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 8. TIER 1: Tool Version Queries (e.g. node --version, dotnet --version)
    if (this.isToolVersionQuery(baseName, args)) {
      return {
        tier: CommandTier.TIER_1_SAFE_READONLY,
        reason: `Read-only tool version query for '${baseName}'.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 9. TIER 3: npx and npm exec (can download and execute untrusted packages)
    if (baseName === 'npx') {
      return {
        tier: CommandTier.TIER_3_ARBITRARY_COMMAND,
        reason: `npx downloads and executes packages from npm registry and requires explicit approval.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }
    if (baseName === 'npm' && args[0]?.toLowerCase() === 'exec') {
      return {
        tier: CommandTier.TIER_3_ARBITRARY_COMMAND,
        reason: `npm exec executes packages from registry or cache and requires explicit approval.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 10. TIER 3: npm package mutation commands (install, uninstall, update)
    if (baseName === 'npm') {
      const npmSub = args[0]?.toLowerCase();
      if (['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'update', 'audit', 'publish'].includes(npmSub)) {
        return {
          tier: CommandTier.TIER_3_ARBITRARY_COMMAND,
          reason: `npm package modification command '${npmSub}' requires explicit approval.`,
          executable: rawExecutable,
          args,
          normalizedCommand
        };
      }
    }

    // 11. TIER 3: dotnet package mutation / template creation commands
    if (baseName === 'dotnet') {
      const dotnetSub = args[0]?.toLowerCase();
      if (['add', 'remove', 'tool', 'new'].includes(dotnetSub)) {
        return {
          tier: CommandTier.TIER_3_ARBITRARY_COMMAND,
          reason: `dotnet package, tool, or template command '${dotnetSub}' requires explicit approval.`,
          executable: rawExecutable,
          args,
          normalizedCommand
        };
      }
    }

    // 12. TIER 2: Project Build, Test, and Verification Commands
    if (this.isTier2ProjectCommand(baseName, args)) {
      return {
        tier: CommandTier.TIER_2_PROJECT_EXECUTION,
        reason: `Project execution command '${baseName} ${args[0] || ''}'. Scripts may execute arbitrary repository code and require explicit approval.`,
        executable: rawExecutable,
        args,
        normalizedCommand
      };
    }

    // 13. TIER 3: Default for all other unclassified non-prohibited commands
    return {
      tier: CommandTier.TIER_3_ARBITRARY_COMMAND,
      reason: `Command '${baseName}' is unclassified and requires explicit user approval.`,
      executable: rawExecutable,
      args,
      normalizedCommand
    };
  }

  /**
   * Check if arguments represent a safe read-only Tier 1 Git inspection command.
   */
  private static checkGitTier1(args: string[]): string | null {
    if (args.length === 0) {
      return null;
    }

    const subcommand = args[0].toLowerCase();
    const remainingArgs = args.slice(1);

    // git --version / -v
    if (subcommand === '--version' || subcommand === '-v') {
      return remainingArgs.length === 0 ? 'Safe git version inquiry.' : null;
    }

    // git status
    if (subcommand === 'status') {
      const allowedStatusFlags = new Set(['--short', '-s', '--porcelain', '--branch', '-b', '-u', '-unormal', '-uall', '-uno']);
      for (const a of remainingArgs) {
        if (!allowedStatusFlags.has(a)) {
          return null;
        }
      }
      return 'Safe read-only git status inspection.';
    }

    // git diff
    if (subcommand === 'diff') {
      const allowedDiffFlags = new Set([
        '--stat', '--name-only', '--name-status', '--cached', '--staged', '--summary', '--patch-with-stat',
        '-p', '-u', '--no-color', '--color=never'
      ]);
      for (const a of remainingArgs) {
        if (a.startsWith('-')) {
          if (!allowedDiffFlags.has(a)) {
            return null; // Unrecognized or unwhitelisted flag demotes from Tier 1
          }
          continue;
        }
        // Non-flag arguments: commit reference or relative file path
        if (/^(HEAD(~[0-9]+)?|[a-f0-9]{7,40})$/.test(a)) {
          continue;
        }
        // Branch, ref, or relative file path (must not contain .. or drive letters or leading slashes)
        if (
          !path.isAbsolute(a) &&
          !a.startsWith('/') &&
          !a.startsWith('\\') &&
          !/^[a-zA-Z]:/.test(a) &&
          !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(a) &&
          /^[a-zA-Z0-9_.\-\/]+$/.test(a)
        ) {
          continue;
        }
        return null;
      }
      return 'Safe read-only git diff inspection.';
    }

    // git log
    if (subcommand === 'log') {
      const allowedLogFlags = new Set([
        '--oneline', '--stat', '--graph', '--decorate', '-p', '--name-only', '--name-status', '--no-color'
      ]);
      for (let i = 0; i < remainingArgs.length; i++) {
        const a = remainingArgs[i];
        if (allowedLogFlags.has(a)) {
          continue;
        }
        if (/^-n\s*[1-9][0-9]*$/.test(a) || /^--max-count=[1-9][0-9]*$/.test(a)) {
          continue;
        }
        if (a === '-n' && i + 1 < remainingArgs.length && /^[1-9][0-9]*$/.test(remainingArgs[i + 1])) {
          i++;
          continue;
        }
        if (a.startsWith('-')) {
          return null; // Unrecognized flag demotes from Tier 1
        }
        if (/^(HEAD(~[0-9]+)?|[a-f0-9]{7,40})$/.test(a)) {
          continue;
        }
        if (
          !path.isAbsolute(a) &&
          !a.startsWith('/') &&
          !a.startsWith('\\') &&
          !/^[a-zA-Z]:/.test(a) &&
          !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(a) &&
          /^[a-zA-Z0-9_.\-\/]+$/.test(a)
        ) {
          continue;
        }
        return null;
      }
      return 'Safe read-only git log inspection.';
    }

    // git branch
    if (subcommand === 'branch') {
      const allowedBranchFlags = new Set(['--list', '-a', '-r', '--show-current', '-l', '--sort=committerdate']);
      for (const a of remainingArgs) {
        if (!allowedBranchFlags.has(a)) {
          return null;
        }
      }
      return 'Safe read-only git branch inspection.';
    }

    return null;
  }

  /**
   * Check if command is a safe read-only version query.
   */
  private static isToolVersionQuery(baseName: string, args: string[]): boolean {
    const safeVersionTools = new Set(['node', 'npm', 'dotnet', 'tsc', 'python', 'python3', 'cargo', 'go']);
    if (!safeVersionTools.has(baseName)) {
      return false;
    }
    if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
      return true;
    }
    return false;
  }

  /**
   * Check if command is a Tier 2 project execution command (build, test, lint).
   */
  private static isTier2ProjectCommand(baseName: string, args: string[]): boolean {
    // npm
    if (baseName === 'npm') {
      const sub = args[0]?.toLowerCase();
      if (sub === 'test' || sub === 'start' || sub === 'build') {
        return true;
      }
      if (sub === 'run' && args.length >= 2) {
        return true;
      }
      return false;
    }

    // dotnet
    if (baseName === 'dotnet') {
      const sub = args[0]?.toLowerCase();
      if (['build', 'test', 'run', 'clean', 'watch'].includes(sub)) {
        return true;
      }
      return false;
    }

    // cargo
    if (baseName === 'cargo') {
      const sub = args[0]?.toLowerCase();
      if (['build', 'test', 'check', 'run', 'clippy'].includes(sub)) {
        return true;
      }
      return false;
    }

    // pytest
    if (baseName === 'pytest') {
      return true;
    }

    // python -m unittest / pytest
    if ((baseName === 'python' || baseName === 'python3') && args[0] === '-m') {
      const mod = args[1]?.toLowerCase();
      if (mod === 'unittest' || mod === 'pytest') {
        return true;
      }
      return false;
    }

    // go
    if (baseName === 'go') {
      const sub = args[0]?.toLowerCase();
      if (['test', 'build', 'run'].includes(sub)) {
        return true;
      }
      return false;
    }

    return false;
  }
}
