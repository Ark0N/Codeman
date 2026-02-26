/**
 * @fileoverview Tests for CLI command parsing and validation
 *
 * Tests command argument parsing, validation, and help text generation.
 */

import { describe, it, expect } from 'vitest';

describe('CLI Command Parsing', () => {
  describe('Command Structure', () => {
    interface Command {
      name: string;
      aliases: string[];
      description: string;
      subcommands?: Command[];
    }

    const commands: Command[] = [
      {
        name: 'session',
        aliases: ['s'],
        description: 'Manage Claude sessions',
        subcommands: [
          { name: 'start', aliases: [], description: 'Start new session' },
          { name: 'stop', aliases: [], description: 'Stop session' },
          { name: 'list', aliases: ['ls'], description: 'List all sessions' },
          { name: 'logs', aliases: [], description: 'View session output' },
        ],
      },
      {
        name: 'task',
        aliases: ['t'],
        description: 'Manage tasks',
        subcommands: [
          { name: 'add', aliases: [], description: 'Add task' },
          { name: 'list', aliases: ['ls'], description: 'List tasks' },
          { name: 'status', aliases: [], description: 'Task details' },
          { name: 'remove', aliases: ['rm'], description: 'Remove task' },
          { name: 'clear', aliases: [], description: 'Clear completed' },
        ],
      },
      {
        name: 'ralph',
        aliases: ['r'],
        description: 'Control Ralph loop',
        subcommands: [
          { name: 'start', aliases: [], description: 'Start loop' },
          { name: 'stop', aliases: [], description: 'Stop loop' },
          { name: 'status', aliases: [], description: 'Show status' },
        ],
      },
      {
        name: 'web',
        aliases: [],
        description: 'Start web interface',
      },
      {
        name: 'tui',
        aliases: [],
        description: 'Start TUI',
      },
      {
        name: 'status',
        aliases: [],
        description: 'Overall status',
      },
      {
        name: 'reset',
        aliases: [],
        description: 'Reset all state',
      },
    ];

    const findCommand = (name: string): Command | undefined => {
      return commands.find(c => c.name === name || c.aliases.includes(name));
    };

    const findSubcommand = (parent: Command, name: string): Command | undefined => {
      return parent.subcommands?.find(c => c.name === name || c.aliases.includes(name));
    };

    it('should find commands by name', () => {
      expect(findCommand('session')?.name).toBe('session');
      expect(findCommand('task')?.name).toBe('task');
      expect(findCommand('ralph')?.name).toBe('ralph');
    });

    it('should find commands by alias', () => {
      expect(findCommand('s')?.name).toBe('session');
      expect(findCommand('t')?.name).toBe('task');
      expect(findCommand('r')?.name).toBe('ralph');
    });

    it('should find subcommands', () => {
      const session = findCommand('session')!;
      expect(findSubcommand(session, 'start')?.name).toBe('start');
      expect(findSubcommand(session, 'list')?.name).toBe('list');
      expect(findSubcommand(session, 'ls')?.name).toBe('list');
    });

    it('should return undefined for unknown commands', () => {
      expect(findCommand('unknown')).toBeUndefined();
    });

    it('should have descriptions for all commands', () => {
      commands.forEach(cmd => {
        expect(cmd.description).toBeTruthy();
      });
    });
  });

  describe('Argument Parsing', () => {
    interface ParsedArgs {
      command?: string;
      subcommand?: string;
      args: string[];
      flags: Record<string, string | boolean>;
    }

    const parseArgs = (argv: string[]): ParsedArgs => {
      const result: ParsedArgs = { args: [], flags: {} };
      let i = 0;

      // Skip node and script name if present
      while (i < argv.length && (argv[i].includes('node') || argv[i].endsWith('.js'))) {
        i++;
      }

      // Parse remaining args
      while (i < argv.length) {
        const arg = argv[i];

        if (arg.startsWith('--')) {
          const key = arg.slice(2);
          const nextArg = argv[i + 1];
          if (nextArg && !nextArg.startsWith('-')) {
            result.flags[key] = nextArg;
            i++;
          } else {
            result.flags[key] = true;
          }
        } else if (arg.startsWith('-')) {
          const key = arg.slice(1);
          const nextArg = argv[i + 1];
          if (nextArg && !nextArg.startsWith('-')) {
            result.flags[key] = nextArg;
            i++;
          } else {
            result.flags[key] = true;
          }
        } else if (!result.command) {
          result.command = arg;
        } else if (!result.subcommand) {
          result.subcommand = arg;
        } else {
          result.args.push(arg);
        }
        i++;
      }

      return result;
    };

    it('should parse simple command', () => {
      const parsed = parseArgs(['status']);
      expect(parsed.command).toBe('status');
    });

    it('should parse command with subcommand', () => {
      const parsed = parseArgs(['session', 'start']);
      expect(parsed.command).toBe('session');
      expect(parsed.subcommand).toBe('start');
    });

    it('should parse boolean flags', () => {
      const parsed = parseArgs(['web', '--verbose']);
      expect(parsed.flags.verbose).toBe(true);
    });

    it('should parse flags with values', () => {
      const parsed = parseArgs(['web', '-p', '8080']);
      expect(parsed.flags.p).toBe('8080');
    });

    it('should parse long flags with values', () => {
      const parsed = parseArgs(['web', '--port', '8080']);
      expect(parsed.flags.port).toBe('8080');
    });

    it('should parse positional arguments', () => {
      const parsed = parseArgs(['session', 'stop', 'session-123']);
      expect(parsed.args).toEqual(['session-123']);
    });

    it('should handle multiple flags', () => {
      const parsed = parseArgs(['tui', '--with-web', '-p', '3000']);
      expect(parsed.flags['with-web']).toBe(true);
      expect(parsed.flags.p).toBe('3000');
    });

    it('should handle empty input', () => {
      const parsed = parseArgs([]);
      expect(parsed.command).toBeUndefined();
      expect(parsed.args).toEqual([]);
    });
  });

  describe('Flag Validation', () => {
    interface FlagDef {
      name: string;
      short?: string;
      type: 'boolean' | 'string' | 'number';
      required?: boolean;
      default?: unknown;
    }

    const webFlags: FlagDef[] = [
      { name: 'port', short: 'p', type: 'number', default: 3000 },
      { name: 'host', short: 'h', type: 'string', default: '0.0.0.0' },
    ];

    const tuiFlags: FlagDef[] = [
      { name: 'port', short: 'p', type: 'number', default: 3000 },
      { name: 'with-web', type: 'boolean', default: false },
      { name: 'no-web', type: 'boolean', default: false },
    ];

    const validateFlag = (value: unknown, def: FlagDef): boolean => {
      if (value === undefined) return !def.required;

      switch (def.type) {
        case 'boolean':
          return typeof value === 'boolean';
        case 'string':
          return typeof value === 'string' && value.length > 0;
        case 'number':
          return typeof value === 'number' || /^\d+$/.test(String(value));
        default:
          return false;
      }
    };

    it('should validate boolean flags', () => {
      expect(validateFlag(true, { name: 'verbose', type: 'boolean' })).toBe(true);
      expect(validateFlag(false, { name: 'verbose', type: 'boolean' })).toBe(true);
      expect(validateFlag('true', { name: 'verbose', type: 'boolean' })).toBe(false);
    });

    it('should validate string flags', () => {
      expect(validateFlag('value', { name: 'host', type: 'string' })).toBe(true);
      expect(validateFlag('', { name: 'host', type: 'string' })).toBe(false);
      expect(validateFlag(123, { name: 'host', type: 'string' })).toBe(false);
    });

    it('should validate number flags', () => {
      expect(validateFlag(8080, { name: 'port', type: 'number' })).toBe(true);
      expect(validateFlag('8080', { name: 'port', type: 'number' })).toBe(true);
      expect(validateFlag('abc', { name: 'port', type: 'number' })).toBe(false);
    });

    it('should handle missing optional flags', () => {
      expect(validateFlag(undefined, { name: 'port', type: 'number' })).toBe(true);
    });

    it('should reject missing required flags', () => {
      expect(validateFlag(undefined, { name: 'port', type: 'number', required: true })).toBe(false);
    });

    it('should have defaults for web flags', () => {
      webFlags.forEach(flag => {
        expect(flag.default).toBeDefined();
      });
    });

    it('should have defaults for tui flags', () => {
      tuiFlags.forEach(flag => {
        expect(flag.default).toBeDefined();
      });
    });
  });

  describe('Port Validation', () => {
    const isValidPort = (port: number): boolean => {
      return Number.isInteger(port) && port >= 1 && port <= 65535;
    };

    const isPrivilegedPort = (port: number): boolean => {
      return port < 1024;
    };

    it('should accept valid ports', () => {
      expect(isValidPort(80)).toBe(true);
      expect(isValidPort(3000)).toBe(true);
      expect(isValidPort(8080)).toBe(true);
      expect(isValidPort(65535)).toBe(true);
    });

    it('should reject invalid ports', () => {
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(-1)).toBe(false);
      expect(isValidPort(65536)).toBe(false);
      expect(isValidPort(100000)).toBe(false);
    });

    it('should reject non-integer ports', () => {
      expect(isValidPort(3000.5)).toBe(false);
      expect(isValidPort(NaN)).toBe(false);
    });

    it('should detect privileged ports', () => {
      expect(isPrivilegedPort(80)).toBe(true);
      expect(isPrivilegedPort(443)).toBe(true);
      expect(isPrivilegedPort(1023)).toBe(true);
      expect(isPrivilegedPort(1024)).toBe(false);
      expect(isPrivilegedPort(3000)).toBe(false);
    });
  });

  describe('Help Text Generation', () => {
    const generateHelp = (command: string, description: string, options: string[]): string => {
      let help = `Usage: codeman ${command}\n\n`;
      help += `${description}\n`;
      if (options.length > 0) {
        help += '\nOptions:\n';
        options.forEach(opt => {
          help += `  ${opt}\n`;
        });
      }
      return help;
    };

    it('should generate basic help', () => {
      const help = generateHelp('status', 'Show overall status', []);
      expect(help).toContain('Usage: codeman status');
      expect(help).toContain('Show overall status');
    });

    it('should include options', () => {
      const help = generateHelp('web', 'Start web interface', [
        '-p, --port <port>  Server port (default: 3000)',
        '-h, --host <host>  Server host (default: 0.0.0.0)',
      ]);
      expect(help).toContain('Options:');
      expect(help).toContain('--port');
      expect(help).toContain('--host');
    });

    it('should format properly', () => {
      const help = generateHelp('test', 'Test command', ['--flag']);
      const lines = help.split('\n');
      expect(lines[0]).toMatch(/^Usage:/);
    });
  });

  describe('Session ID Validation', () => {
    const isValidSessionId = (id: string): boolean => {
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
    };

    const isValidShortId = (id: string): boolean => {
      // Short format: session-timestamp-random
      return /^session-\d+-[a-z0-9]+$/.test(id);
    };

    it('should validate UUID session IDs', () => {
      expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    });

    it('should reject invalid UUIDs', () => {
      expect(isValidSessionId('not-a-uuid')).toBe(false);
      expect(isValidSessionId('550e8400-e29b-41d4-a716')).toBe(false);
      expect(isValidSessionId('')).toBe(false);
    });

    it('should validate short session IDs', () => {
      expect(isValidShortId('session-1234567890-abc123')).toBe(true);
    });

    it('should reject invalid short IDs', () => {
      expect(isValidShortId('session-abc-123')).toBe(false);
      expect(isValidShortId('not-session-123-abc')).toBe(false);
    });
  });

  describe('Case Name Validation', () => {
    const isValidCaseName = (name: string): boolean => {
      if (name.length === 0 || name.length > 100) return false;
      // Allow alphanumeric, hyphens, underscores
      return /^[a-zA-Z0-9_-]+$/.test(name);
    };

    const sanitizeCaseName = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 100);
    };

    it('should accept valid case names', () => {
      expect(isValidCaseName('my-project')).toBe(true);
      expect(isValidCaseName('project_v2')).toBe(true);
      expect(isValidCaseName('Test123')).toBe(true);
    });

    it('should reject invalid case names', () => {
      expect(isValidCaseName('')).toBe(false);
      expect(isValidCaseName('my project')).toBe(false);
      expect(isValidCaseName('project@v2')).toBe(false);
    });

    it('should reject too long names', () => {
      expect(isValidCaseName('x'.repeat(101))).toBe(false);
    });

    it('should sanitize names', () => {
      expect(sanitizeCaseName('My Project!')).toBe('my-project');
      expect(sanitizeCaseName('test@#$123')).toBe('test-123');
      expect(sanitizeCaseName('  spaces  ')).toBe('spaces');
    });

    it('should handle consecutive special chars', () => {
      expect(sanitizeCaseName('a!!!b')).toBe('a-b');
    });
  });

  describe('Prompt Validation', () => {
    const MAX_PROMPT_LENGTH = 100000;

    const isValidPrompt = (prompt: string): boolean => {
      return prompt.length > 0 && prompt.length <= MAX_PROMPT_LENGTH;
    };

    const truncatePrompt = (prompt: string, maxLength: number = MAX_PROMPT_LENGTH): string => {
      if (prompt.length <= maxLength) return prompt;
      return prompt.substring(0, maxLength - 3) + '...';
    };

    it('should accept valid prompts', () => {
      expect(isValidPrompt('Hello')).toBe(true);
      expect(isValidPrompt('A'.repeat(1000))).toBe(true);
    });

    it('should reject empty prompts', () => {
      expect(isValidPrompt('')).toBe(false);
    });

    it('should reject too long prompts', () => {
      expect(isValidPrompt('A'.repeat(MAX_PROMPT_LENGTH + 1))).toBe(false);
    });

    it('should truncate long prompts', () => {
      const longPrompt = 'A'.repeat(100);
      const truncated = truncatePrompt(longPrompt, 50);
      expect(truncated.length).toBe(50);
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('should not truncate short prompts', () => {
      const shortPrompt = 'Hello';
      expect(truncatePrompt(shortPrompt, 50)).toBe(shortPrompt);
    });
  });
});

describe('CLI Output Formatting', () => {
  describe('Table Formatting', () => {
    interface Column {
      header: string;
      width: number;
    }

    const formatRow = (values: string[], columns: Column[]): string => {
      return values.map((val, i) => {
        const width = columns[i]?.width || 10;
        return val.padEnd(width).substring(0, width);
      }).join(' ');
    };

    const formatTable = (headers: string[], rows: string[][], widths: number[]): string => {
      const columns = headers.map((h, i) => ({ header: h, width: widths[i] }));
      const headerRow = formatRow(headers, columns);
      const separator = columns.map(c => '-'.repeat(c.width)).join(' ');
      const dataRows = rows.map(row => formatRow(row, columns));
      return [headerRow, separator, ...dataRows].join('\n');
    };

    it('should format single row', () => {
      const columns = [{ header: 'ID', width: 10 }, { header: 'Status', width: 8 }];
      const row = formatRow(['123', 'active'], columns);
      expect(row).toBe('123        active  ');
    });

    it('should truncate long values', () => {
      const columns = [{ header: 'Name', width: 5 }];
      const row = formatRow(['verylongname'], columns);
      expect(row).toBe('veryl');
    });

    it('should format complete table', () => {
      const table = formatTable(
        ['ID', 'Status'],
        [['1', 'active'], ['2', 'idle']],
        [5, 8]
      );
      expect(table).toContain('ID');
      expect(table).toContain('Status');
      expect(table).toContain('-----');
      expect(table).toContain('active');
    });
  });

  describe('Status Formatting', () => {
    const formatStatus = (status: string): string => {
      const statusMap: Record<string, string> = {
        active: '● active',
        idle: '○ idle',
        working: '◐ working',
        error: '✗ error',
        stopped: '□ stopped',
      };
      return statusMap[status] || status;
    };

    it('should format active status', () => {
      expect(formatStatus('active')).toBe('● active');
    });

    it('should format idle status', () => {
      expect(formatStatus('idle')).toBe('○ idle');
    });

    it('should format working status', () => {
      expect(formatStatus('working')).toBe('◐ working');
    });

    it('should format error status', () => {
      expect(formatStatus('error')).toBe('✗ error');
    });

    it('should return unknown status as-is', () => {
      expect(formatStatus('unknown')).toBe('unknown');
    });
  });

  describe('Token Formatting', () => {
    const formatTokens = (tokens: number): string => {
      if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`;
      }
      if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(1)}k`;
      }
      return tokens.toString();
    };

    it('should format millions', () => {
      expect(formatTokens(1_500_000)).toBe('1.5M');
      expect(formatTokens(2_000_000)).toBe('2.0M');
    });

    it('should format thousands', () => {
      expect(formatTokens(1_500)).toBe('1.5k');
      expect(formatTokens(100_000)).toBe('100.0k');
    });

    it('should format small numbers', () => {
      expect(formatTokens(500)).toBe('500');
      expect(formatTokens(0)).toBe('0');
    });
  });

  describe('Cost Formatting', () => {
    const formatCost = (cost: number): string => {
      if (cost < 0.01) {
        return `$${cost.toFixed(4)}`;
      }
      return `$${cost.toFixed(2)}`;
    };

    it('should format small costs with 4 decimals', () => {
      expect(formatCost(0.0015)).toBe('$0.0015');
      expect(formatCost(0.0001)).toBe('$0.0001');
    });

    it('should format normal costs with 2 decimals', () => {
      expect(formatCost(1.50)).toBe('$1.50');
      expect(formatCost(0.05)).toBe('$0.05');
    });

    it('should handle zero', () => {
      expect(formatCost(0)).toBe('$0.0000');
    });
  });

  describe('Duration Formatting', () => {
    const formatDuration = (ms: number): string => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
      }
      if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
      }
      return `${seconds}s`;
    };

    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
      expect(formatDuration(45000)).toBe('45s');
    });

    it('should format minutes', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(300000)).toBe('5m 0s');
    });

    it('should format hours', () => {
      expect(formatDuration(3600000)).toBe('1h 0m');
      expect(formatDuration(5400000)).toBe('1h 30m');
    });

    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0s');
    });
  });

  describe('List Formatting', () => {
    const formatList = (items: string[], bullet: string = '-'): string => {
      return items.map(item => `${bullet} ${item}`).join('\n');
    };

    const formatNumberedList = (items: string[]): string => {
      return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
    };

    it('should format bulleted list', () => {
      const list = formatList(['item1', 'item2', 'item3']);
      expect(list).toBe('- item1\n- item2\n- item3');
    });

    it('should format with custom bullet', () => {
      const list = formatList(['item1', 'item2'], '*');
      expect(list).toBe('* item1\n* item2');
    });

    it('should format numbered list', () => {
      const list = formatNumberedList(['item1', 'item2', 'item3']);
      expect(list).toBe('1. item1\n2. item2\n3. item3');
    });

    it('should handle empty list', () => {
      expect(formatList([])).toBe('');
      expect(formatNumberedList([])).toBe('');
    });
  });

  describe('Error Message Formatting', () => {
    const formatError = (message: string, code?: string): string => {
      if (code) {
        return `Error [${code}]: ${message}`;
      }
      return `Error: ${message}`;
    };

    it('should format error with code', () => {
      const error = formatError('Session not found', 'NOT_FOUND');
      expect(error).toBe('Error [NOT_FOUND]: Session not found');
    });

    it('should format error without code', () => {
      const error = formatError('Something went wrong');
      expect(error).toBe('Error: Something went wrong');
    });
  });

  describe('Progress Formatting', () => {
    const formatProgress = (current: number, total: number, width: number = 20): string => {
      const percent = Math.round((current / total) * 100);
      const filled = Math.round((current / total) * width);
      const empty = width - filled;
      return `[${'='.repeat(filled)}${' '.repeat(empty)}] ${percent}%`;
    };

    it('should format progress at 0%', () => {
      const progress = formatProgress(0, 100, 10);
      expect(progress).toBe('[          ] 0%');
    });

    it('should format progress at 50%', () => {
      const progress = formatProgress(50, 100, 10);
      expect(progress).toBe('[=====     ] 50%');
    });

    it('should format progress at 100%', () => {
      const progress = formatProgress(100, 100, 10);
      expect(progress).toBe('[==========] 100%');
    });

    it('should handle non-round percentages', () => {
      const progress = formatProgress(33, 100, 10);
      expect(progress).toBe('[===       ] 33%');
    });
  });
});

describe('CLI Configuration', () => {
  describe('Default Configuration', () => {
    interface CLIConfig {
      maxConcurrentSessions: number;
      defaultPort: number;
      defaultHost: string;
      casesDirectory: string;
      stateDirectory: string;
    }

    const defaultConfig: CLIConfig = {
      maxConcurrentSessions: 5,
      defaultPort: 3000,
      defaultHost: '0.0.0.0',
      casesDirectory: '~/codeman-cases',
      stateDirectory: '~/.codeman',
    };

    const expandPath = (path: string): string => {
      if (path.startsWith('~/')) {
        return `/home/user${path.slice(1)}`;
      }
      return path;
    };

    it('should have sensible defaults', () => {
      expect(defaultConfig.maxConcurrentSessions).toBe(5);
      expect(defaultConfig.defaultPort).toBe(3000);
      expect(defaultConfig.defaultHost).toBe('0.0.0.0');
    });

    it('should expand home directory paths', () => {
      expect(expandPath('~/codeman-cases')).toBe('/home/user/codeman-cases');
      expect(expandPath('~/.codeman')).toBe('/home/user/.codeman');
    });

    it('should not modify absolute paths', () => {
      expect(expandPath('/var/data')).toBe('/var/data');
    });
  });

  describe('Environment Variable Parsing', () => {
    const parseEnvInt = (value: string | undefined, defaultValue: number): number => {
      if (value === undefined) return defaultValue;
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const parseEnvBool = (value: string | undefined, defaultValue: boolean): boolean => {
      if (value === undefined) return defaultValue;
      return value.toLowerCase() === 'true' || value === '1';
    };

    it('should parse integer env vars', () => {
      expect(parseEnvInt('8080', 3000)).toBe(8080);
      expect(parseEnvInt(undefined, 3000)).toBe(3000);
      expect(parseEnvInt('invalid', 3000)).toBe(3000);
    });

    it('should parse boolean env vars', () => {
      expect(parseEnvBool('true', false)).toBe(true);
      expect(parseEnvBool('1', false)).toBe(true);
      expect(parseEnvBool('false', true)).toBe(false);
      expect(parseEnvBool(undefined, true)).toBe(true);
    });
  });

  describe('Config File Parsing', () => {
    interface ConfigFile {
      port?: number;
      host?: string;
      maxSessions?: number;
    }

    const parseConfigFile = (content: string): ConfigFile => {
      try {
        return JSON.parse(content);
      } catch {
        return {};
      }
    };

    const mergeConfigs = (defaults: ConfigFile, file: ConfigFile, env: ConfigFile): ConfigFile => {
      return { ...defaults, ...file, ...env };
    };

    it('should parse valid JSON config', () => {
      const config = parseConfigFile('{"port": 8080}');
      expect(config.port).toBe(8080);
    });

    it('should handle invalid JSON', () => {
      const config = parseConfigFile('invalid json');
      expect(config).toEqual({});
    });

    it('should merge configs with priority', () => {
      const defaults = { port: 3000, host: 'localhost' };
      const file = { port: 8080 };
      const env = { host: '0.0.0.0' };
      const merged = mergeConfigs(defaults, file, env);
      expect(merged.port).toBe(8080);
      expect(merged.host).toBe('0.0.0.0');
    });
  });
});
