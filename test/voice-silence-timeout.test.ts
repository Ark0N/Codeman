import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

afterEach(() => vi.useRealTimers());

const source = readFileSync(new URL('../src/web/public/voice-input.js', import.meta.url), 'utf8');
function load(silenceTimeout?: unknown, overrides: Record<string, unknown> = {}) {
  vi.useRealTimers();
  vi.useFakeTimers();
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    app: { showToast: vi.fn() },
    console,
    navigator: {},
    WebSocket: { OPEN: 1 },
    localStorage: { getItem: () => JSON.stringify({ silenceTimeout }) },
    ...overrides,
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
  it('does not stop interim dictation at the former 750ms stability deadline', () => {
    for (const setting of [0, 3, 15]) {
      const voice = load(setting)[2];
      voice.isRecording = true;
      voice._showPreview = vi.fn();
      voice.stop = vi.fn();
      voice._onWebSpeechResult({ results: [[{ transcript: 'thinking' }]] });
      vi.advanceTimersByTime(750);
      expect(voice.stop).not.toHaveBeenCalled();
    }
  });
  it('restarts browser recognition without extending the silence deadline', () => {
    const voice = load(15)[2];
    voice.isRecording = true;
    voice._recordingStartedAt = Date.now() - 1000;
    voice.recognition = { start: vi.fn() };
    voice.stop = vi.fn();
    voice._hasReceivedResult = true;
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
    voice._onWebSpeechResult({ resultIndex: 1, results: [result, interim] });
    voice.stop();
    voice.stop();
    expect(voice._insertText).not.toHaveBeenCalled();
    voice._onWebSpeechEnd();
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
  it('keeps a corrected final through the configured silence deadline', () => {
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

function claudeSession(setting: number) {
  const [, provider, voice] = load(setting);
  voice._claudeStatus = { available: true };
  for (const method of [
    '_showPreview',
    '_startDurationTimer',
    '_stopDurationTimer',
    '_stopLevelMeter',
    '_updateButtons',
    '_hidePreview',
    '_hideVoiceSendBtn',
  ])
    voice[method] = vi.fn();
  voice._insertText = vi.fn();
  provider.start = vi.fn((opts) => {
    provider._finalized = false;
    provider._ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    provider._onResult = opts.onResult;
    provider._onEnd = opts.onEnd;
    provider._resetSilenceTimeout();
  });
  voice._startClaude();
  return { provider, voice };
}

describe('Claude utterances and teardown', () => {
  it.each([0, 15])('keeps two final utterances through a thinking pause with setting %s', (setting) => {
    const { provider, voice } = claudeSession(setting);
    provider._onResult('first phrase', false);
    provider._onResult('first phrase', true);
    expect(voice.isRecording).toBe(true);
    vi.advanceTimersByTime(2000);
    provider._onResult('second phrase', false);
    voice.stop();
    provider._onResult('second phrase', true);
    expect(voice._insertText).toHaveBeenCalledExactlyOnceWith('first phrase second phrase');
    expect(voice.isRecording).toBe(false);
  });
  it('salvages partial text and leaves the mic idle on SSE cleanup', () => {
    const { provider, voice } = claudeSession(0);
    provider._onResult('keep this partial', false);
    voice.cleanup();
    expect(voice._insertText).toHaveBeenCalledExactlyOnceWith('keep this partial');
    expect(voice.isRecording).toBe(false);
    expect(voice._activeProvider).toBeNull();
    expect(provider._ws).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds finalization triggered by the provider silence timer too', () => {
    const { provider, voice } = claudeSession(3);
    provider._onResult('before silence', false);
    vi.advanceTimersByTime(3000);
    expect(provider._finalized).toBe(true);
    expect(voice.isRecording).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(voice._insertText).toHaveBeenCalledExactlyOnceWith('before silence');
    expect(voice.isRecording).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a dead-link finalization wait and repeated taps cannot extend it', () => {
    const { provider, voice } = claudeSession(0);
    provider._onResult('salvage on timeout', false);
    voice.stop();
    vi.advanceTimersByTime(4000);
    voice.stop();
    expect(voice.isRecording).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(voice._insertText).toHaveBeenCalledExactlyOnceWith('salvage on timeout');
    expect(voice.isRecording).toBe(false);
    expect(provider._ws).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('empty browser recognition runs', () => {
  it('backs off and stops after repeated empty ends instead of a tight restart loop', () => {
    const voice = load(0)[2];
    voice.isRecording = true;
    voice._activeProvider = 'webspeech';
    voice.recognition = { start: vi.fn() };
    voice.stop = vi.fn();
    voice._onWebSpeechEnd();
    expect(voice.recognition.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(voice.recognition.start).toHaveBeenCalledTimes(1);
    voice._onWebSpeechEnd();
    vi.advanceTimersByTime(250);
    expect(voice.recognition.start).toHaveBeenCalledTimes(2);
    voice._onWebSpeechEnd();
    vi.advanceTimersByTime(10000);
    expect(voice.recognition.start).toHaveBeenCalledTimes(2);
    expect(voice.stop).toHaveBeenCalledWith(true);
  });
  it('resets the empty-run budget after actual speech', () => {
    const voice = load(0)[2];
    voice.isRecording = true;
    voice._activeProvider = 'webspeech';
    voice.recognition = { start: vi.fn() };
    voice._showPreview = vi.fn();
    voice.stop = vi.fn();
    voice._onWebSpeechEnd();
    vi.advanceTimersByTime(250);
    voice._onWebSpeechResult({ results: [[{ transcript: 'a real phrase' }]] });
    voice._onWebSpeechEnd();
    voice._onWebSpeechEnd();
    vi.advanceTimersByTime(250);
    voice._onWebSpeechEnd();
    vi.advanceTimersByTime(250);
    expect(voice.recognition.start).toHaveBeenCalledTimes(4);
    expect(voice.stop).not.toHaveBeenCalled();
    expect(voice._accumulatedFinal).toBe('a real phrase');
  });
  it('does not restart the microphone after Stop during an empty-run backoff', () => {
    const voice = load(0)[2];
    voice.isRecording = true;
    voice._activeProvider = 'webspeech';
    for (const method of ['_stopDurationTimer', '_stopLevelMeter', '_updateButtons', '_hidePreview'])
      voice[method] = vi.fn();
    voice.recognition = { start: vi.fn(), stop: vi.fn() };
    voice._onWebSpeechEnd();
    voice.stop();
    vi.advanceTimersByTime(10000);
    expect(voice.recognition.start).not.toHaveBeenCalled();
    expect(voice.isRecording).toBe(false);
  });
});

describe('Claude acquisition cancellation', () => {
  function pendingMicrophone() {
    let grant!: (value: unknown) => void;
    const microphone = new Promise((resolve) => {
      grant = resolve;
    });
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const sockets: any[] = [];
    class Socket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    }
    const [, provider] = load(0, {
      navigator: { mediaDevices: { getUserMedia: () => microphone } },
      URLSearchParams,
      WebSocket: Socket,
      location: { protocol: 'https:', host: 'fixture.invalid' },
      window: {},
    });
    const onStream = vi.fn();
    const onError = vi.fn();
    return { provider, grant, track, stream, sockets, onStream, onError };
  }
  it('releases a microphone granted after cleanup without opening a socket', async () => {
    const h = pendingMicrophone();
    const started = h.provider.start({ onStream: h.onStream, onError: h.onError });
    h.provider._cleanup();
    h.grant(h.stream);
    await started;
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.sockets).toHaveLength(0);
    expect(h.onStream).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.provider._stream).toBeNull();
  });
  it('cancels a connecting socket and detaches its capture callback', async () => {
    const h = pendingMicrophone();
    const started = h.provider.start({ onStream: h.onStream, onError: h.onError });
    h.grant(h.stream);
    await started;
    const socket = h.sockets[0];
    expect(socket.onopen).toBeTypeOf('function');
    h.provider._cleanup();
    expect(socket.onopen).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.provider._ws).toBeNull();
  });
});
