/**
 * @fileoverview Tests for terminal output parsing utilities
 *
 * Tests various terminal output parsing patterns used throughout
 * the Codeman application.
 */

import { describe, it, expect } from 'vitest';

describe('Terminal Output Parsing', () => {
  describe('ANSI Escape Code Stripping', () => {
    // Comprehensive ANSI escape pattern including DEC Private Mode sequences
    const stripAnsi = (str: string): string => {
      return str.replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '');
    };

    it('should strip color codes', () => {
      expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
      expect(stripAnsi('\x1b[1;34mbold blue\x1b[0m')).toBe('bold blue');
      expect(stripAnsi('\x1b[31;1mred bold\x1b[0m')).toBe('red bold');
    });

    it('should strip cursor movement codes', () => {
      expect(stripAnsi('\x1b[Htext')).toBe('text');
      expect(stripAnsi('\x1b[2Jclear')).toBe('clear');
      expect(stripAnsi('\x1b[10;20Hposition')).toBe('position');
    });

    it('should strip multiple codes', () => {
      expect(stripAnsi('\x1b[32m\x1b[1mmultiple\x1b[0m')).toBe('multiple');
    });

    it('should handle no codes', () => {
      expect(stripAnsi('plain text')).toBe('plain text');
    });

    it('should handle empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('should strip complex sequences', () => {
      const complex = '\x1b[?25l\x1b[32mtext\x1b[0m\x1b[?25h';
      expect(stripAnsi(complex)).toBe('text');
    });
  });

  describe('Token Parsing', () => {
    const parseTokens = (line: string): { total: number; unit: string } | null => {
      const match = line.match(/(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens?/);
      if (!match) return null;

      let total = parseFloat(match[1]);
      const unit = match[2]?.toLowerCase() || '';

      if (unit === 'k') total *= 1000;
      else if (unit === 'm') total *= 1000000;

      return { total, unit };
    };

    it('should parse simple token count', () => {
      const result = parseTokens('100 tokens');
      expect(result?.total).toBe(100);
    });

    it('should parse k (thousand) suffix', () => {
      const result = parseTokens('50k tokens');
      expect(result?.total).toBe(50000);
    });

    it('should parse K (uppercase) suffix', () => {
      const result = parseTokens('50K tokens');
      expect(result?.total).toBe(50000);
    });

    it('should parse m (million) suffix', () => {
      const result = parseTokens('1.5m tokens');
      expect(result?.total).toBe(1500000);
    });

    it('should parse decimal values', () => {
      const result = parseTokens('123.4k tokens');
      expect(result?.total).toBe(123400);
    });

    it('should handle singular "token"', () => {
      const result = parseTokens('1 token');
      expect(result?.total).toBe(1);
    });

    it('should return null for no match', () => {
      expect(parseTokens('no token count')).toBeNull();
    });

    it('should handle embedded token count', () => {
      const result = parseTokens('Used 50k tokens so far');
      expect(result?.total).toBe(50000);
    });
  });

  describe('Cost Parsing', () => {
    const parseCost = (line: string): number | null => {
      const match = line.match(/\$([0-9]+(?:\.[0-9]+)?)/);
      return match ? parseFloat(match[1]) : null;
    };

    it('should parse dollar amounts', () => {
      expect(parseCost('Cost: $0.05')).toBe(0.05);
      expect(parseCost('$1.23')).toBe(1.23);
      expect(parseCost('Total: $10.00')).toBe(10.00);
    });

    it('should handle integer amounts', () => {
      expect(parseCost('$5')).toBe(5);
    });

    it('should return null for no match', () => {
      expect(parseCost('no cost here')).toBeNull();
    });

    it('should parse first occurrence', () => {
      expect(parseCost('$0.01 and $0.02')).toBe(0.01);
    });
  });

  describe('Prompt Detection', () => {
    const isPrompt = (line: string): boolean => {
      const promptPatterns = [
        /❯\s*$/,
        />\s*$/,
        /\$\s*$/,
        /⏵\s*$/,
        /↵\s*send/,
      ];
      return promptPatterns.some(p => p.test(line));
    };

    it('should detect chevron prompt', () => {
      expect(isPrompt('❯ ')).toBe(true);
      expect(isPrompt('dir ❯')).toBe(true);
    });

    it('should detect greater-than prompt', () => {
      expect(isPrompt('> ')).toBe(true);
    });

    it('should detect dollar prompt', () => {
      expect(isPrompt('user$ ')).toBe(true);
    });

    it('should detect play button prompt', () => {
      expect(isPrompt('⏵ ')).toBe(true);
    });

    it('should detect send indicator', () => {
      expect(isPrompt('↵ send')).toBe(true);
    });

    it('should not match regular text', () => {
      expect(isPrompt('Hello world')).toBe(false);
    });
  });

  describe('Working State Detection', () => {
    const isWorking = (line: string): boolean => {
      const workingPatterns = [
        /\bThinking\b/i,
        /\bWriting\b/i,
        /\bRunning\b/i,
        /\bSearching\b/i,
        /\bReading\b/i,
        /\bAnalyzing\b/i,
        /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
      ];
      return workingPatterns.some(p => p.test(line));
    };

    it('should detect Thinking state', () => {
      expect(isWorking('Thinking...')).toBe(true);
      expect(isWorking('thinking about it')).toBe(true);
    });

    it('should detect Writing state', () => {
      expect(isWorking('Writing code...')).toBe(true);
    });

    it('should detect Running state', () => {
      expect(isWorking('Running tests...')).toBe(true);
    });

    it('should detect spinner characters', () => {
      expect(isWorking('Loading ⠋')).toBe(true);
      expect(isWorking('⠹ Processing')).toBe(true);
    });

    it('should not match idle text', () => {
      expect(isWorking('Ready for input')).toBe(false);
    });
  });

  describe('Line Buffering', () => {
    class LineBuffer {
      private buffer = '';

      process(data: string): string[] {
        this.buffer += data;
        const lines: string[] = [];
        let newlineIndex;

        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
          lines.push(this.buffer.slice(0, newlineIndex));
          this.buffer = this.buffer.slice(newlineIndex + 1);
        }

        return lines;
      }

      getRemaining(): string {
        return this.buffer;
      }

      clear(): void {
        this.buffer = '';
      }
    }

    it('should buffer incomplete lines', () => {
      const buffer = new LineBuffer();
      const lines = buffer.process('incomplete');
      expect(lines).toHaveLength(0);
      expect(buffer.getRemaining()).toBe('incomplete');
    });

    it('should emit complete lines', () => {
      const buffer = new LineBuffer();
      const lines = buffer.process('complete\n');
      expect(lines).toEqual(['complete']);
      expect(buffer.getRemaining()).toBe('');
    });

    it('should handle multiple lines', () => {
      const buffer = new LineBuffer();
      const lines = buffer.process('line1\nline2\nline3\n');
      expect(lines).toEqual(['line1', 'line2', 'line3']);
    });

    it('should accumulate across calls', () => {
      const buffer = new LineBuffer();

      let lines = buffer.process('par');
      expect(lines).toHaveLength(0);

      lines = buffer.process('tial\n');
      expect(lines).toEqual(['partial']);
    });

    it('should clear buffer', () => {
      const buffer = new LineBuffer();
      buffer.process('data');
      buffer.clear();
      expect(buffer.getRemaining()).toBe('');
    });
  });

  describe('JSON Message Parsing', () => {
    interface ClaudeMessage {
      type: 'system' | 'assistant' | 'user' | 'result';
      message?: {
        content: Array<{ type: string; text?: string }>;
      };
      total_cost_usd?: number;
    }

    const parseClaudeMessage = (line: string): ClaudeMessage | null => {
      try {
        const cleaned = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    };

    it('should parse valid JSON', () => {
      const json = '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}';
      const msg = parseClaudeMessage(json);
      expect(msg?.type).toBe('assistant');
      expect(msg?.message?.content[0].text).toBe('Hello');
    });

    it('should parse JSON with ANSI codes', () => {
      const json = '\x1b[32m{"type":"system"}\x1b[0m';
      const msg = parseClaudeMessage(json);
      expect(msg?.type).toBe('system');
    });

    it('should return null for invalid JSON', () => {
      expect(parseClaudeMessage('not json')).toBeNull();
      expect(parseClaudeMessage('{invalid}')).toBeNull();
    });

    it('should parse result message with cost', () => {
      const json = '{"type":"result","total_cost_usd":0.05}';
      const msg = parseClaudeMessage(json);
      expect(msg?.type).toBe('result');
      expect(msg?.total_cost_usd).toBe(0.05);
    });
  });

  describe('Tool Use Detection', () => {
    const detectToolUse = (content: Array<{ type: string; name?: string }>): string[] => {
      return content
        .filter(block => block.type === 'tool_use' && block.name)
        .map(block => block.name!);
    };

    it('should detect single tool use', () => {
      const content = [
        { type: 'text', text: 'Let me read the file' },
        { type: 'tool_use', name: 'Read' },
      ];
      expect(detectToolUse(content)).toEqual(['Read']);
    });

    it('should detect multiple tool uses', () => {
      const content = [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Write' },
        { type: 'tool_use', name: 'Bash' },
      ];
      expect(detectToolUse(content)).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should handle no tool uses', () => {
      const content = [
        { type: 'text', text: 'Just text' },
      ];
      expect(detectToolUse(content)).toEqual([]);
    });

    it('should ignore tool_result', () => {
      const content = [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_result' },
      ];
      expect(detectToolUse(content)).toEqual(['Read']);
    });
  });

  describe('Completion Phrase Extraction', () => {
    const extractCompletionPhrase = (text: string): string | null => {
      const match = text.match(/<promise>([A-Z0-9_-]+)<\/promise>/);
      return match ? match[1] : null;
    };

    it('should extract simple phrase', () => {
      expect(extractCompletionPhrase('<promise>COMPLETE</promise>')).toBe('COMPLETE');
    });

    it('should extract phrase with underscores', () => {
      expect(extractCompletionPhrase('<promise>ALL_DONE</promise>')).toBe('ALL_DONE');
    });

    it('should extract phrase with hyphens', () => {
      expect(extractCompletionPhrase('<promise>TESTS-PASS</promise>')).toBe('TESTS-PASS');
    });

    it('should extract phrase with numbers', () => {
      expect(extractCompletionPhrase('<promise>TASK_123</promise>')).toBe('TASK_123');
    });

    it('should return null for no match', () => {
      expect(extractCompletionPhrase('no promise here')).toBeNull();
    });

    it('should not match lowercase', () => {
      expect(extractCompletionPhrase('<promise>lowercase</promise>')).toBeNull();
    });

    it('should not match empty promise', () => {
      expect(extractCompletionPhrase('<promise></promise>')).toBeNull();
    });
  });

  describe('Iteration Pattern Detection', () => {
    const parseIteration = (text: string): { current: number; max: number | null } | null => {
      // Pattern: "Iteration 5/50" or "[5/50]" or "Iteration 5"
      const slashMatch = text.match(/(?:Iteration\s+)?(\d+)\s*\/\s*(\d+)/i);
      if (slashMatch) {
        return {
          current: parseInt(slashMatch[1], 10),
          max: parseInt(slashMatch[2], 10),
        };
      }

      const bracketMatch = text.match(/\[(\d+)\s*\/\s*(\d+)\]/);
      if (bracketMatch) {
        return {
          current: parseInt(bracketMatch[1], 10),
          max: parseInt(bracketMatch[2], 10),
        };
      }

      const simpleMatch = text.match(/[Ii]teration\s+(\d+)/);
      if (simpleMatch) {
        return {
          current: parseInt(simpleMatch[1], 10),
          max: null,
        };
      }

      return null;
    };

    it('should parse "Iteration 5/50"', () => {
      const result = parseIteration('Iteration 5/50');
      expect(result?.current).toBe(5);
      expect(result?.max).toBe(50);
    });

    it('should parse "[5/50]"', () => {
      const result = parseIteration('[5/50] Working...');
      expect(result?.current).toBe(5);
      expect(result?.max).toBe(50);
    });

    it('should parse "Iteration 3" without max', () => {
      const result = parseIteration('Iteration 3 - processing');
      expect(result?.current).toBe(3);
      expect(result?.max).toBeNull();
    });

    it('should parse embedded patterns', () => {
      const result = parseIteration('Log: Iteration 10/100 started');
      expect(result?.current).toBe(10);
      expect(result?.max).toBe(100);
    });

    it('should return null for no match', () => {
      expect(parseIteration('no iteration')).toBeNull();
    });
  });

  describe('Todo Checkbox Parsing', () => {
    const parseTodoCheckbox = (line: string): { content: string; status: string } | null => {
      // Match "- [ ] Task" or "- [x] Task" or "* [ ] Task"
      const match = line.match(/^[\s\-*]*\[\s*([xX ])\s*\]\s*(.+)$/);
      if (!match) return null;

      return {
        content: match[2].trim(),
        status: match[1].toLowerCase() === 'x' ? 'completed' : 'pending',
      };
    };

    it('should parse pending checkbox', () => {
      const result = parseTodoCheckbox('- [ ] Task to do');
      expect(result?.content).toBe('Task to do');
      expect(result?.status).toBe('pending');
    });

    it('should parse completed checkbox', () => {
      const result = parseTodoCheckbox('- [x] Done task');
      expect(result?.content).toBe('Done task');
      expect(result?.status).toBe('completed');
    });

    it('should parse uppercase X', () => {
      const result = parseTodoCheckbox('- [X] Also done');
      expect(result?.status).toBe('completed');
    });

    it('should parse asterisk bullet', () => {
      const result = parseTodoCheckbox('* [ ] Asterisk item');
      expect(result?.content).toBe('Asterisk item');
    });

    it('should handle leading whitespace', () => {
      const result = parseTodoCheckbox('  - [ ] Indented task');
      expect(result?.content).toBe('Indented task');
    });

    it('should return null for non-checkbox', () => {
      expect(parseTodoCheckbox('Just text')).toBeNull();
      expect(parseTodoCheckbox('- No checkbox')).toBeNull();
    });
  });

  describe('Cycle Pattern Detection', () => {
    const parseCycleNumber = (text: string): number | null => {
      // Match "cycle #5" or "Starting cycle #10" or "respawn cycle #3"
      const match = text.match(/cycle\s*#(\d+)/i);
      return match ? parseInt(match[1], 10) : null;
    };

    it('should parse "cycle #5"', () => {
      expect(parseCycleNumber('cycle #5')).toBe(5);
    });

    it('should parse "Starting cycle #10"', () => {
      expect(parseCycleNumber('Starting cycle #10')).toBe(10);
    });

    it('should parse "respawn cycle #3"', () => {
      expect(parseCycleNumber('respawn cycle #3')).toBe(3);
    });

    it('should handle case insensitivity', () => {
      expect(parseCycleNumber('CYCLE #7')).toBe(7);
      expect(parseCycleNumber('Cycle #7')).toBe(7);
    });

    it('should return null for no match', () => {
      expect(parseCycleNumber('no cycle here')).toBeNull();
    });
  });

  describe('Elapsed Time Parsing', () => {
    const parseElapsedTime = (text: string): number | null => {
      // Match "Elapsed: X.X hours" or "X.X hours elapsed"
      const match = text.match(/(\d+(?:\.\d+)?)\s*hours?/i);
      return match ? parseFloat(match[1]) : null;
    };

    it('should parse "Elapsed: 2.5 hours"', () => {
      expect(parseElapsedTime('Elapsed: 2.5 hours')).toBe(2.5);
    });

    it('should parse integer hours', () => {
      expect(parseElapsedTime('5 hours elapsed')).toBe(5);
    });

    it('should parse singular "hour"', () => {
      expect(parseElapsedTime('1 hour')).toBe(1);
    });

    it('should parse decimal hours', () => {
      expect(parseElapsedTime('0.5 hours')).toBe(0.5);
    });

    it('should return null for no match', () => {
      expect(parseElapsedTime('no time here')).toBeNull();
    });
  });

  describe('Buffer Size Limits', () => {
    const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB
    const TRIM_TO_SIZE = 1.5 * 1024 * 1024; // 1.5MB

    const trimBuffer = (buffer: string): string => {
      if (buffer.length > MAX_BUFFER_SIZE) {
        return buffer.slice(-TRIM_TO_SIZE);
      }
      return buffer;
    };

    it('should not trim small buffers', () => {
      const small = 'x'.repeat(1000);
      expect(trimBuffer(small)).toBe(small);
    });

    it('should trim large buffers', () => {
      const large = 'x'.repeat(MAX_BUFFER_SIZE + 1000);
      const trimmed = trimBuffer(large);
      expect(trimmed.length).toBe(TRIM_TO_SIZE);
    });

    it('should keep recent data', () => {
      const buffer = 'old'.repeat(MAX_BUFFER_SIZE / 3) + 'new'.repeat(TRIM_TO_SIZE / 3);
      const trimmed = trimBuffer(buffer);
      expect(trimmed.endsWith('newnewnew')).toBe(true);
    });
  });

  describe('Message Count Limits', () => {
    const MAX_MESSAGES = 1000;
    const TRIM_TO = 800;

    const trimMessages = <T>(messages: T[]): T[] => {
      if (messages.length > MAX_MESSAGES) {
        return messages.slice(-TRIM_TO);
      }
      return messages;
    };

    it('should not trim small arrays', () => {
      const arr = Array.from({ length: 100 }, (_, i) => i);
      expect(trimMessages(arr)).toEqual(arr);
    });

    it('should trim large arrays', () => {
      const arr = Array.from({ length: 1500 }, (_, i) => i);
      const trimmed = trimMessages(arr);
      expect(trimmed.length).toBe(TRIM_TO);
    });

    it('should keep recent messages', () => {
      const arr = Array.from({ length: 1200 }, (_, i) => i);
      const trimmed = trimMessages(arr);
      expect(trimmed[trimmed.length - 1]).toBe(1199);
    });
  });
});
