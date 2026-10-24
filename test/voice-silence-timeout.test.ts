import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const source = readFileSync(new URL('../src/web/public/voice-input.js', import.meta.url), 'utf8');
function load(silenceTimeout?: unknown) {
  vi.useRealTimers();
  vi.useFakeTimers();
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    console,
    navigator: {},
    WebSocket: { OPEN: 1 },
    localStorage: { getItem: () => JSON.stringify({ silenceTimeout }) },
  });
  const providers = vm.runInContext(`${source}\n[DeepgramProvider, ClaudeVoiceProvider, VoiceInput]`, context);
  return providers as Array<Record<string, any>>;
}

describe('voice silence timeout', () => {
  for (const [index, name, legacy] of [
    [0, 'Deepgram', 3000],
    [1, 'Claude', 6000],
    [2, 'browser', 3000],
  ] as const) {
    it(`${name} keeps its default and accepts longer thinking pauses`, () => {
      for (const [setting, delay] of [
        [undefined, legacy],
        [15, 15000],
        [30, 30000],
      ] as const) {
        const provider = load(setting)[index];
        provider.isRecording = true;
        provider.stop = vi.fn();
        provider._resetSilenceTimeout();
        vi.advanceTimersByTime(delay - 1);
        expect(provider.stop).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(provider.stop).toHaveBeenCalledOnce();
      }
    });
    it(`${name} resets its deadline and cancels it in manual mode`, () => {
      const providers = load(15);
      const provider = providers[index];
      provider.isRecording = true;
      provider.stop = vi.fn();
      provider._resetSilenceTimeout();
      vi.advanceTimersByTime(10000);
      provider._resetSilenceTimeout();
      vi.advanceTimersByTime(10000);
      expect(provider.stop).not.toHaveBeenCalled();
      providers[2]._getDeepgramConfig = () => ({ silenceTimeout: 0 });
      provider._resetSilenceTimeout();
      vi.advanceTimersByTime(120000);
      expect(provider.stop).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  it.each([null, -1, '15', 1.5, 999])('ignores invalid local values: %s', (setting) => {
    const voice = load(setting)[2];
    expect(voice.getSilenceTimeoutMs(6000)).toBe(6000);
  });
  it('does not let the iOS stability shortcut stop extended/manual dictation', () => {
    for (const setting of [0, 15]) {
      const voice = load(setting)[2];
      voice.isRecording = true;
      voice._iosStabilityCheck('thinking');
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('restarts browser recognition without extending the silence deadline', () => {
    const voice = load(15)[2];
    voice.isRecording = true;
    voice._recordingStartedAt = Date.now() - 1000;
    voice.recognition = { start: vi.fn() };
    voice.stop = vi.fn();
    voice._resetSilenceTimeout();
    vi.advanceTimersByTime(10000);
    voice._onWebSpeechEnd();
    expect(voice.recognition.start).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(voice.stop).toHaveBeenCalledOnce();
  });
  it('keeps final browser phrases and Safari interim text until an explicit stop', () => {
    const voice = load(0)[2];
    voice.isRecording = true;
    voice._activeProvider = 'webspeech';
    for (const method of ['_showPreview', '_stopDurationTimer', '_stopLevelMeter', '_updateButtons', '_hidePreview'])
      voice[method] = vi.fn();
    voice._insertText = vi.fn();
    voice.recognition = { stop: vi.fn() };
    const result = [{ transcript: 'first phrase ' }];
    Object.assign(result, { isFinal: true });
    voice._onWebSpeechResult({ resultIndex: 0, results: [result] });
    expect(voice.isRecording).toBe(true);
    expect(voice._insertText).not.toHaveBeenCalled();
    const interim = [{ transcript: 'thinking aloud' }];
    voice._onWebSpeechResult({ resultIndex: 0, results: [interim] });
    voice.stop();
    voice.stop();
    expect(voice._insertText).toHaveBeenCalledExactlyOnceWith('first phrase thinking aloud');
  });
  it('preserves mixed final/interim results across browser recognition restarts', () => {
    const voice = load(0)[2];
    voice.isRecording = true;
    voice._recordingStartedAt = Date.now() - 1000;
    voice._showPreview = vi.fn();
    voice.recognition = { start: vi.fn() };
    const final = Object.assign([{ transcript: 'first ' }], { isFinal: true });
    const interim = [{ transcript: 'second' }];
    voice._onWebSpeechResult({ resultIndex: 0, results: [final, interim] });
    expect(voice._accumulatedFinal + voice._pendingInterim).toBe('first second');
    voice._onWebSpeechEnd();
    voice._onWebSpeechResult({ resultIndex: 0, results: [[{ transcript: 'third' }]] });
    expect(voice._accumulatedFinal + voice._pendingInterim).toBe('first second third');
  });
  it('ignores repeated stop requests while waiting for Claude final text', () => {
    const [_, provider, voice] = load(0);
    voice.isRecording = true;
    voice._activeProvider = 'claude';
    provider._ws = { readyState: 1 };
    provider.stop = vi.fn(() => {
      provider._finalized = true;
    });
    voice._insertText = vi.fn();
    voice.stop();
    voice.stop();
    expect(voice._insertText).not.toHaveBeenCalled();
    expect(voice.isRecording).toBe(true);
  });
  it('cancels Safari stability text when a final result supersedes it', () => {
    const voice = load(3)[2];
    voice.isRecording = true;
    voice._showPreview = vi.fn();
    voice.stop = vi.fn();
    voice._onWebSpeechResult({ resultIndex: 0, results: [[{ transcript: 'hello' }]] });
    const final = Object.assign([{ transcript: 'hello' }], { isFinal: true });
    voice._onWebSpeechResult({ resultIndex: 0, results: [final] });
    vi.advanceTimersByTime(750);
    expect(voice.stop).not.toHaveBeenCalled();
    expect(voice._accumulatedFinal + voice._pendingInterim).toBe('hello');
  });
  it('round-trips the setting through server validation', () => {
    for (const silenceTimeout of [0, 3, 6, 15, 30]) {
      expect(SettingsUpdateSchema.parse({ voiceSettings: { silenceTimeout } }).voiceSettings).toEqual({
        silenceTimeout,
      });
    }
    expect(SettingsUpdateSchema.safeParse({ voiceSettings: { silenceTimeout: -1 } }).success).toBe(false);
  });
});
