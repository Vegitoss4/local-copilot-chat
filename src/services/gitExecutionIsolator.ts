export class GitExecutionIsolator {
  /**
   * Sanitizes and isolates Git arguments to prevent pager hanging, external diff/merge tool execution,
   * local repository hook hijacking, and text conversion attacks.
   */
  public static isolateArguments(args: string[]): string[] {
    const result: string[] = [];

    // Ensure --no-pager is inserted before the subcommand if not already present
    if (!args.includes('--no-pager')) {
      result.push('--no-pager');
    }

    // Global configuration overrides to neutralize local repository hooks and external tools
    const safeConfigOverrides = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'diff.external=',
      '-c', 'merge.tool=',
      '-c', 'diff.tool=',
    ];

    for (let i = 0; i < safeConfigOverrides.length; i += 2) {
      const flag = safeConfigOverrides[i];
      const val = safeConfigOverrides[i + 1];
      if (!args.includes(val)) {
        result.push(flag, val);
      }
    }

    const firstSubcommand = args.find(a => !a.startsWith('-'));
    for (const arg of args) {
      result.push(arg);
      if (arg === firstSubcommand && arg === 'diff') {
        if (!args.includes('--no-ext-diff')) {
          result.push('--no-ext-diff');
        }
        if (!args.includes('--no-textconv')) {
          result.push('--no-textconv');
        }
      }
    }

    return result;
  }

  /**
   * Generates a hardened environment for Git processes that prevents
   * system-level and repository-level configuration hijacking (.git/config pager or hooks).
   */
  public static getIsolatedEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
      ...baseEnv,
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    };
  }
}
