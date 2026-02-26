/**
 * @fileoverview Tests for buffer management and memory limits
 *
 * Tests the buffer management strategies used in Codeman sessions
 * for handling large terminal output and message storage.
 */

import { describe, it, expect } from 'vitest';

describe('Buffer Management', () => {
  describe('Terminal Buffer Limits', () => {
    const MAX_TERMINAL_BUFFER = 2 * 1024 * 1024; // 2MB
    const TRIM_TERMINAL_TO = 1.5 * 1024 * 1024;  // 1.5MB

    class TerminalBuffer {
      private buffer = '';

      append(data: string): void {
        this.buffer += data;
        this.trim();
      }

      private trim(): void {
        if (this.buffer.length > MAX_TERMINAL_BUFFER) {
          this.buffer = this.buffer.slice(-TRIM_TERMINAL_TO);
        }
      }

      get content(): string {
        return this.buffer;
      }

      get size(): number {
        return this.buffer.length;
      }

      clear(): void {
        this.buffer = '';
      }
    }

    it('should append data normally within limits', () => {
      const buffer = new TerminalBuffer();
      buffer.append('Hello ');
      buffer.append('World');
      expect(buffer.content).toBe('Hello World');
    });

    it('should not trim when under limit', () => {
      const buffer = new TerminalBuffer();
      buffer.append('x'.repeat(1000000)); // 1MB
      expect(buffer.size).toBe(1000000);
    });

    it('should trim when over limit', () => {
      const buffer = new TerminalBuffer();
      buffer.append('x'.repeat(MAX_TERMINAL_BUFFER + 100000));
      expect(buffer.size).toBe(TRIM_TERMINAL_TO);
    });

    it('should keep most recent data', () => {
      const buffer = new TerminalBuffer();
      buffer.append('old'.repeat(1000000));
      buffer.append('new'.repeat(1000000));
      expect(buffer.content.endsWith('newnewnew')).toBe(true);
    });

    it('should clear buffer', () => {
      const buffer = new TerminalBuffer();
      buffer.append('data');
      buffer.clear();
      expect(buffer.size).toBe(0);
    });
  });

  describe('Text Output Buffer Limits', () => {
    const MAX_TEXT_BUFFER = 1 * 1024 * 1024; // 1MB
    const TRIM_TEXT_TO = 768 * 1024;         // 768KB

    class TextBuffer {
      private buffer = '';

      append(data: string): void {
        this.buffer += data;
        this.trim();
      }

      private trim(): void {
        if (this.buffer.length > MAX_TEXT_BUFFER) {
          this.buffer = this.buffer.slice(-TRIM_TEXT_TO);
        }
      }

      get content(): string {
        return this.buffer;
      }

      get size(): number {
        return this.buffer.length;
      }
    }

    it('should trim at 1MB limit', () => {
      const buffer = new TextBuffer();
      buffer.append('x'.repeat(MAX_TEXT_BUFFER + 1000));
      expect(buffer.size).toBe(TRIM_TEXT_TO);
    });

    it('should keep recent text', () => {
      const buffer = new TextBuffer();
      buffer.append('old'.repeat(400000));
      buffer.append('new'.repeat(400000));
      expect(buffer.content.includes('newnewnew')).toBe(true);
    });
  });

  describe('Message Array Limits', () => {
    const MAX_MESSAGES = 1000;
    const TRIM_MESSAGES_TO = 800;

    class MessageStore<T> {
      private messages: T[] = [];

      add(message: T): void {
        this.messages.push(message);
        this.trim();
      }

      private trim(): void {
        if (this.messages.length > MAX_MESSAGES) {
          this.messages = this.messages.slice(-TRIM_MESSAGES_TO);
        }
      }

      get all(): T[] {
        return [...this.messages];
      }

      get count(): number {
        return this.messages.length;
      }

      clear(): void {
        this.messages = [];
      }
    }

    it('should store messages normally within limits', () => {
      const store = new MessageStore<string>();
      for (let i = 0; i < 100; i++) {
        store.add(`Message ${i}`);
      }
      expect(store.count).toBe(100);
    });

    it('should trim when over limit', () => {
      const store = new MessageStore<number>();
      for (let i = 0; i < 1202; i++) {
        store.add(i);
      }
      expect(store.count).toBe(TRIM_MESSAGES_TO);
    });

    it('should keep recent messages', () => {
      const store = new MessageStore<number>();
      for (let i = 0; i < 1202; i++) {
        store.add(i);
      }
      const all = store.all;
      expect(all[all.length - 1]).toBe(1201);
      expect(all[0]).toBe(1201 - TRIM_MESSAGES_TO + 1);
    });
  });

  describe('Line Buffer Limits', () => {
    const MAX_LINE_BUFFER = 64 * 1024; // 64KB

    class LineBuffer {
      private buffer = '';
      private maxSize: number;

      constructor(maxSize = MAX_LINE_BUFFER) {
        this.maxSize = maxSize;
      }

      process(data: string): string[] {
        this.buffer += data;

        // Limit buffer size
        if (this.buffer.length > this.maxSize) {
          this.buffer = this.buffer.slice(-this.maxSize);
        }

        const lines: string[] = [];
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          lines.push(this.buffer.slice(0, idx));
          this.buffer = this.buffer.slice(idx + 1);
        }
        return lines;
      }

      get remaining(): string {
        return this.buffer;
      }
    }

    it('should process complete lines', () => {
      const buffer = new LineBuffer();
      const lines = buffer.process('line1\nline2\n');
      expect(lines).toEqual(['line1', 'line2']);
    });

    it('should buffer incomplete lines', () => {
      const buffer = new LineBuffer();
      buffer.process('incomplete');
      expect(buffer.remaining).toBe('incomplete');
    });

    it('should limit buffer size', () => {
      const buffer = new LineBuffer(100);
      buffer.process('x'.repeat(200));
      expect(buffer.remaining.length).toBe(100);
    });
  });

  describe('Respawn Buffer Limits', () => {
    const MAX_RESPAWN_BUFFER = 1 * 1024 * 1024; // 1MB
    const TRIM_RESPAWN_TO = 512 * 1024;         // 512KB

    class RespawnBuffer {
      private buffer = '';

      append(data: string): void {
        this.buffer += data;
        if (this.buffer.length > MAX_RESPAWN_BUFFER) {
          this.buffer = this.buffer.slice(-TRIM_RESPAWN_TO);
        }
      }

      get content(): string {
        return this.buffer;
      }

      get size(): number {
        return this.buffer.length;
      }

      clear(): void {
        this.buffer = '';
      }
    }

    it('should trim at 1MB limit', () => {
      const buffer = new RespawnBuffer();
      buffer.append('x'.repeat(MAX_RESPAWN_BUFFER + 1000));
      expect(buffer.size).toBe(TRIM_RESPAWN_TO);
    });
  });

  describe('Chunked Writing', () => {
    const CHUNK_SIZE = 64 * 1024; // 64KB

    const splitIntoChunks = (data: string, chunkSize = CHUNK_SIZE): string[] => {
      const chunks: string[] = [];
      for (let i = 0; i < data.length; i += chunkSize) {
        chunks.push(data.slice(i, i + chunkSize));
      }
      return chunks;
    };

    it('should split large data into chunks', () => {
      const data = 'x'.repeat(200000); // 200KB
      const chunks = splitIntoChunks(data);
      expect(chunks.length).toBe(4); // ceil(200000/65536)
    });

    it('should handle small data', () => {
      const data = 'small';
      const chunks = splitIntoChunks(data);
      expect(chunks).toEqual(['small']);
    });

    it('should preserve data when rejoined', () => {
      const data = 'Hello World! '.repeat(10000);
      const chunks = splitIntoChunks(data);
      expect(chunks.join('')).toBe(data);
    });

    it('should handle exact chunk boundaries', () => {
      const data = 'x'.repeat(CHUNK_SIZE * 2);
      const chunks = splitIntoChunks(data);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(CHUNK_SIZE);
      expect(chunks[1].length).toBe(CHUNK_SIZE);
    });
  });

  describe('Tab Switch Tail Limit', () => {
    const TAB_SWITCH_TAIL = 256 * 1024; // 256KB

    const getTabSwitchData = (buffer: string): string => {
      if (buffer.length <= TAB_SWITCH_TAIL) {
        return buffer;
      }
      return buffer.slice(-TAB_SWITCH_TAIL);
    };

    it('should return full buffer if small', () => {
      const buffer = 'small data';
      expect(getTabSwitchData(buffer)).toBe(buffer);
    });

    it('should return last 256KB of large buffer', () => {
      const buffer = 'x'.repeat(500000);
      const result = getTabSwitchData(buffer);
      expect(result.length).toBe(TAB_SWITCH_TAIL);
    });

    it('should preserve recent data', () => {
      const buffer = 'old'.repeat(100000) + 'new'.repeat(100000);
      const result = getTabSwitchData(buffer);
      expect(result.endsWith('newnewnew')).toBe(true);
    });
  });

  describe('Truncation Indicators', () => {
    const TRUNCATION_MESSAGE = '[Earlier output truncated]\n\n';

    const addTruncationIndicator = (trimmedData: string, wasTrimmed: boolean): string => {
      if (wasTrimmed) {
        return TRUNCATION_MESSAGE + trimmedData;
      }
      return trimmedData;
    };

    it('should add indicator when truncated', () => {
      const result = addTruncationIndicator('data', true);
      expect(result.startsWith('[Earlier output truncated]')).toBe(true);
    });

    it('should not add indicator when not truncated', () => {
      const result = addTruncationIndicator('data', false);
      expect(result).toBe('data');
    });
  });

  describe('Memory Efficient Iteration', () => {
    it('should iterate without creating intermediate arrays', () => {
      const map = new Map<string, number>();
      for (let i = 0; i < 100; i++) {
        map.set(`key-${i}`, i);
      }

      // Efficient iteration
      let count = 0;
      for (const [_key, value] of map) {
        if (value > 50) count++;
      }
      expect(count).toBe(49);
    });

    it('should use generator for large sequences', () => {
      function* generateNumbers(max: number) {
        for (let i = 0; i < max; i++) {
          yield i;
        }
      }

      let sum = 0;
      for (const n of generateNumbers(1000)) {
        sum += n;
      }
      expect(sum).toBe(499500);
    });
  });

  describe('String Builder Pattern', () => {
    class StringBuilder {
      private parts: string[] = [];
      private totalLength = 0;

      append(str: string): void {
        this.parts.push(str);
        this.totalLength += str.length;
      }

      toString(): string {
        const result = this.parts.join('');
        // Reset to single string for future operations
        this.parts = [result];
        return result;
      }

      get length(): number {
        return this.totalLength;
      }
    }

    it('should efficiently build strings', () => {
      const sb = new StringBuilder();
      for (let i = 0; i < 1000; i++) {
        sb.append(`Line ${i}\n`);
      }
      expect(sb.length).toBeGreaterThan(0);
      expect(sb.toString()).toContain('Line 999');
    });

    it('should track total length', () => {
      const sb = new StringBuilder();
      sb.append('Hello ');
      sb.append('World');
      expect(sb.length).toBe(11);
    });
  });

  describe('Batched Updates', () => {
    class BatchedEmitter {
      private pending: string[] = [];
      private timeoutId: NodeJS.Timeout | null = null;
      private batchInterval: number;
      public emitCount = 0;

      constructor(batchInterval = 50) {
        this.batchInterval = batchInterval;
      }

      add(item: string): void {
        this.pending.push(item);
        this.scheduleBatch();
      }

      private scheduleBatch(): void {
        if (this.timeoutId) return;
        this.timeoutId = setTimeout(() => {
          this.flush();
        }, this.batchInterval);
      }

      flush(): void {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        if (this.pending.length > 0) {
          this.emitCount++;
          this.pending = [];
        }
      }
    }

    it('should batch rapid updates', () => {
      const emitter = new BatchedEmitter(100);
      for (let i = 0; i < 100; i++) {
        emitter.add(`item-${i}`);
      }
      emitter.flush();
      expect(emitter.emitCount).toBe(1);
    });

    it('should emit when flushed', () => {
      const emitter = new BatchedEmitter();
      emitter.add('item');
      emitter.flush();
      expect(emitter.emitCount).toBe(1);
    });
  });

  describe('Circular Buffer', () => {
    class CircularBuffer<T> {
      private buffer: T[];
      private head = 0;
      private tail = 0;
      private count = 0;
      private capacity: number;

      constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
      }

      push(item: T): void {
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        if (this.count < this.capacity) {
          this.count++;
        } else {
          this.head = (this.head + 1) % this.capacity;
        }
      }

      toArray(): T[] {
        const result: T[] = [];
        for (let i = 0; i < this.count; i++) {
          result.push(this.buffer[(this.head + i) % this.capacity]);
        }
        return result;
      }

      get size(): number {
        return this.count;
      }
    }

    it('should store items up to capacity', () => {
      const buffer = new CircularBuffer<number>(5);
      for (let i = 0; i < 3; i++) {
        buffer.push(i);
      }
      expect(buffer.size).toBe(3);
      expect(buffer.toArray()).toEqual([0, 1, 2]);
    });

    it('should overwrite old items when full', () => {
      const buffer = new CircularBuffer<number>(3);
      for (let i = 0; i < 5; i++) {
        buffer.push(i);
      }
      expect(buffer.size).toBe(3);
      expect(buffer.toArray()).toEqual([2, 3, 4]);
    });

    it('should maintain insertion order', () => {
      const buffer = new CircularBuffer<string>(100);
      for (let i = 0; i < 10; i++) {
        buffer.push(`item-${i}`);
      }
      const arr = buffer.toArray();
      expect(arr[0]).toBe('item-0');
      expect(arr[9]).toBe('item-9');
    });
  });

  describe('Debounced Save', () => {
    class DebouncedSaver {
      private dirty = false;
      private saveTimeout: NodeJS.Timeout | null = null;
      private debounceMs: number;
      public saveCount = 0;

      constructor(debounceMs = 500) {
        this.debounceMs = debounceMs;
      }

      markDirty(): void {
        this.dirty = true;
        this.scheduleSave();
      }

      private scheduleSave(): void {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
          this.saveNow();
        }, this.debounceMs);
      }

      saveNow(): void {
        if (this.saveTimeout) {
          clearTimeout(this.saveTimeout);
          this.saveTimeout = null;
        }
        if (this.dirty) {
          this.saveCount++;
          this.dirty = false;
        }
      }
    }

    it('should debounce rapid saves', () => {
      const saver = new DebouncedSaver(100);
      for (let i = 0; i < 100; i++) {
        saver.markDirty();
      }
      saver.saveNow();
      expect(saver.saveCount).toBe(1);
    });

    it('should save immediately with saveNow', () => {
      const saver = new DebouncedSaver();
      saver.markDirty();
      saver.saveNow();
      expect(saver.saveCount).toBe(1);
    });

    it('should not save if not dirty', () => {
      const saver = new DebouncedSaver();
      saver.saveNow();
      expect(saver.saveCount).toBe(0);
    });
  });
});
