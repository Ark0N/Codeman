import fs from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'vitest';
const source = fs.readFileSync(new URL('../src/web/public/voice-input.js', import.meta.url), 'utf8');
function result(text, final = true) {
  return Object.assign([{ transcript: text }], { isFinal: final });
}
function harness({
  platform = 'Android',
  ua = 'Mozilla/5.0 (Linux; Android 15) Chrome/141.0',
  touch = 5,
  delay = 0,
} = {}) {
  let now = 1000,
    next = 0,
    starts = 0,
    mic = 0;
  const timers = new Map(),
    frames = new Map(),
    inserted = [],
    previews = [],
    attrs = {};
  const bars = Array.from({ length: 5 }, () => ({
    active: false,
    classList: {
      toggle(_name, on) {
        this.owner.active = on;
      },
    },
  }));
  for (const bar of bars) bar.classList.owner = bar;
  const meter = {
    children: bars,
    setAttribute(k, v) {
      attrs[k] = v;
    },
  };
  class Recognition {
    start() {
      starts++;
      this.results = [];
    }
    stop() {}
    abort() {}
    // Chromium Android promotes every native partial into a new final when continuous=true.
    partial(text) {
      if (this.continuous) this.results.push(result(text));
      else this.results = [result(text, false)];
      this.onresult({ resultIndex: this.continuous ? this.results.length - 1 : 0, results: this.results });
    }
    final(text) {
      if (this.continuous) this.results.push(result(text));
      else this.results = [result(text)];
      this.onresult({ resultIndex: this.continuous ? this.results.length - 1 : 0, results: this.results });
    }
  }
  const context = vm.createContext({
    console,
    window: { SpeechRecognition: Recognition },
    navigator: {
      userAgent: ua,
      platform: platform === 'Windows' ? 'Win32' : 'Linux aarch64',
      userAgentData: { platform },
      maxTouchPoints: touch,
      mediaDevices: {
        getUserMedia() {
          mic++;
          throw Error('second microphone capture');
        },
      },
    },
    localStorage: { getItem: () => JSON.stringify({ silenceTimeout: delay }) },
    app: { showToast() {} },
    WebSocket: { OPEN: 1 },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout(fn, ms) {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
    clearInterval() {},
    requestAnimationFrame(fn) {
      frames.set(++next, fn);
      return next;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const voice = vm.runInContext(source + '\nVoiceInput', context);
  for (const name of [
    '_updateButtons',
    '_startDurationTimer',
    '_stopDurationTimer',
    '_hidePreview',
    '_hideVoiceSendBtn',
  ])
    voice[name] = () => {};
  voice.previewEl = { querySelector: () => meter, remove() {} };
  voice._showPreview = (text) => previews.push(text);
  voice._insertText = (text) => inserted.push(text);
  voice._initRecognition();
  return {
    voice,
    inserted,
    previews,
    bars,
    attrs,
    timers,
    frames,
    get starts() {
      return starts;
    },
    get mic() {
      return mic;
    },
    frame(delta = 120) {
      now += delta;
      const jobs = [...frames.values()];
      frames.clear();
      for (const fn of jobs) fn(now);
    },
    event(results, index = 0) {
      voice._onWebSpeechResult({ results, resultIndex: index });
    },
    finish() {
      voice.stop();
      voice._onWebSpeechEnd();
    },
  };
}
test('Android growing partial phrases and final insert exactly five words', () => {
  const h = harness();
  h.voice._startWebSpeech();
  for (const phrase of ['one', 'one two', 'one two three', 'one two three four', 'one two three four five'])
    h.voice.recognition.partial(phrase);
  h.voice.recognition.final('one two three four five');
  h.finish();
  expect(h.inserted).toEqual(['one two three four five']);
  expect(h.mic).toBe(0);
});
test('Android desktop-site mode also avoids continuous partial-to-final promotion', () => {
  const h = harness({ platform: 'Linux', ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0' });
  expect(h.voice.recognition.continuous).toBe(false);
});
test('Windows keeps continuous recognition and repeated snapshots do not append twice', () => {
  const h = harness({ platform: 'Windows', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0' });
  h.voice._startWebSpeech();
  expect(h.voice.recognition.continuous).toBe(true);
  h.event([result('yes yes'), result('do it', false)], 0);
  h.event([result('yes yes'), result('do it', false)], 0);
  h.event([result('yes yes'), result('do it')], 1);
  h.event([result('yes yes'), result('do it')], 0);
  h.finish();
  expect(h.inserted).toEqual(['yes yes do it']);
});
test('an interim correction replaces the previous text, including removed interim results', () => {
  const h = harness();
  h.voice._startWebSpeech();
  h.event([result('keep this'), result('wrong', false)]);
  h.event([result('keep this'), result('correct', false)], 1);
  expect(h.previews.at(-1)).toBe('keep this correct');
  h.event([result('keep this')], 1);
  h.finish();
  expect(h.inserted).toEqual(['keep this']);
});
for (const delay of [0, 3, 6, 15, 30])
  test(`Android preserves intentional repeated phrases across native ends with ${delay}s silence setting`, () => {
    const h = harness({ delay });
    h.voice._startWebSpeech();
    h.voice.recognition.final('go go');
    h.voice._onWebSpeechEnd();
    expect(h.starts).toBe(2);
    h.voice.recognition.partial('go go');
    h.voice.recognition.final('go go');
    h.finish();
    expect(h.inserted).toEqual(['go go go go']);
  });
test('speech events animate bars, silence clears them, and Stop cancels animation', () => {
  const h = harness();
  h.voice._startWebSpeech();
  expect(h.bars.filter((b) => b.active).length).toBe(0);
  expect(typeof h.voice.recognition.onsoundstart).toBe('function');
  h.voice.recognition.onsoundstart();
  h.frame();
  const count = h.bars.filter((b) => b.active).length;
  expect(count).toBeGreaterThan(0);
  h.frame(300);
  expect(h.bars.filter((b) => b.active).length).not.toBe(count);
  h.voice.recognition.onsoundend();
  h.frame();
  expect(h.bars.filter((b) => b.active).length).toBe(0);
  h.voice.recognition.onspeechstart();
  h.frame();
  expect(h.bars.some((b) => b.active)).toBe(true);
  h.finish();
  expect(h.frames.size).toBe(0);
  expect(h.mic).toBe(0);
});
test('engines without sound events briefly animate on transcript updates', () => {
  const h = harness();
  h.voice._startWebSpeech();
  h.voice.recognition.partial('hello');
  h.frame();
  expect(h.bars.some((b) => b.active)).toBe(true);
  h.frame(1000);
  expect(h.bars.filter((b) => b.active).length).toBe(0);
  h.finish();
});
test('a new dictation starts with no words from the previous dictation', () => {
  const h = harness();
  h.voice._startWebSpeech();
  h.voice.recognition.final('first');
  h.finish();
  h.voice._startWebSpeech();
  h.voice.recognition.final('second');
  h.finish();
  expect(h.inserted).toEqual(['first', 'second']);
});
test('default 3-second silence deadline does not stop Android after a 750ms stable interim', () => {
  const h = harness({ delay: 3 });
  h.voice._startWebSpeech();
  h.voice.recognition.partial('five words spoken very clearly');
  expect([...h.timers.values()].map((t) => t.ms)).toEqual([3000]);
});
test('interim-only native end cannot be reinserted by an old stability callback', () => {
  const h = harness({ delay: 3 });
  h.voice._startWebSpeech();
  h.voice.recognition.partial('five words spoken very clearly');
  h.voice._onWebSpeechEnd();
  expect(h.starts).toBe(2);
  // Execute the callbacks that were queued before the native end, in deadline order.
  const pending = [...h.timers.entries()].sort((a, b) => a[1].ms - b[1].ms);
  for (const [id, timer] of pending) {
    if (h.timers.delete(id)) timer.fn();
  }
  h.voice._onWebSpeechEnd();
  expect(h.inserted).toEqual(['five words spoken very clearly']);
});

function stopHarness() {
  const timers = new Map(),
    inserted = [],
    previews = [],
    toasts = [];
  let next = 0,
    micRequests = 0,
    stops = 0,
    starts = 0;
  const context = vm.createContext({
    console,
    app: { showToast: (text) => toasts.push(text) },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/141.0',
      mediaDevices: {
        getUserMedia: async () => {
          micRequests++;
          return { getTracks: () => [] };
        },
      },
    },
    localStorage: { getItem: () => JSON.stringify({ silenceTimeout: 0 }) },
    WebSocket: { OPEN: 1 },
    setTimeout: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
    clearInterval() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
  });
  const [voice, claude] = vm.runInContext(source + '\n[VoiceInput,ClaudeVoiceProvider]', context);
  voice.recognition = {
    start() {
      starts++;
    },
    stop() {
      stops++;
    },
    abort() {},
  };
  voice.supported = true;
  for (const name of [
    '_updateButtons',
    '_startDurationTimer',
    '_stopDurationTimer',
    '_startLevelMeter',
    '_stopLevelMeter',
    '_hidePreview',
    '_hideVoiceSendBtn',
  ])
    voice[name] = () => {};
  voice._showPreview = (text) => previews.push(text);
  voice._insertText = (text) => inserted.push(text);
  return {
    voice,
    claude,
    timers,
    inserted,
    previews,
    toasts,
    get micRequests() {
      return micRequests;
    },
    get stops() {
      return stops;
    },
    get starts() {
      return starts;
    },
  };
}
function stopResult(voice, text, final = true) {
  voice._onWebSpeechResult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] });
}
test('browser recognition owns the microphone without a competing cosmetic recorder', async () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  await Promise.resolve();
  expect(h.starts).toBe(1);
  expect(h.micRequests).toBe(0);
  stopResult(h.voice, 'live Android words', false);
  expect(h.previews.at(-1)).toBe('live Android words');
});
test('tap Stop accepts a delayed final transcript and inserts once on end', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  h.voice.stop();
  expect(h.stops).toBe(1);
  expect(h.inserted).toEqual([]);
  stopResult(h.voice, 'words arriving after stop');
  h.voice._onWebSpeechEnd();
  h.voice._onWebSpeechEnd();
  expect(h.inserted).toEqual(['words arriving after stop']);
  expect(h.voice.isRecording).toBe(false);
  expect(h.starts).toBe(1);
});
test('repeated Stop does not finalize early or restart recognition', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  h.voice.stop();
  h.voice.stop();
  stopResult(h.voice, 'last phrase');
  h.voice._onWebSpeechEnd();
  expect(h.inserted).toEqual(['last phrase']);
  expect(h.stops).toBe(1);
  expect(h.starts).toBe(1);
});
test('stop timeout preserves interim words if the browser never ends', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  stopResult(h.voice, 'interim words', false);
  h.voice.stop();
  const timeout = [...h.timers.values()].find((t) => t.ms === 3000);
  expect(timeout, 'bounded wait for the browser final result').toBeTruthy();
  timeout.fn();
  expect(h.inserted).toEqual(['interim words']);
  expect(h.voice.isRecording).toBe(false);
  stopResult(h.voice, 'too late');
  expect(h.inserted).toEqual(['interim words']);
});
test('manual thinking pauses still restart natural recognition ends and retain words', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  stopResult(h.voice, 'first phrase', false);
  h.voice._onWebSpeechEnd();
  stopResult(h.voice, 'second phrase');
  h.voice.stop();
  h.voice._onWebSpeechEnd();
  expect(h.inserted).toEqual(['first phrase second phrase']);
  expect(h.starts).toBe(2);
});
test('Claude still accepts its final transcript after finalize', () => {
  const h = stopHarness();
  h.voice.isRecording = true;
  h.voice._activeProvider = 'claude';
  h.claude._ws = { readyState: 1 };
  let finalized = 0;
  h.claude.stop = () => finalized++;
  h.voice.stop();
  expect(h.voice.isRecording).toBe(true);
  h.voice._accumulatedFinal = 'Claude final';
  h.voice.stop(true);
  expect(h.inserted).toEqual(['Claude final']);
  expect(finalized).toBeGreaterThanOrEqual(1);
});

test('failed start ends immediately with an error instead of waiting for a final result', () => {
  const h = stopHarness();
  h.voice.recognition.start = () => {
    throw new Error('fixture failure');
  };
  h.voice._startWebSpeech();
  expect(h.voice.isRecording).toBe(false);
  expect(h.toasts[0]).toMatch(/fixture failure/);
  expect(h.timers.size).toBe(0);
});
test('failed stop still inserts available words and clears the finishing timer', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  stopResult(h.voice, 'existing words', false);
  h.voice.recognition.stop = () => {
    throw new Error('already stopped');
  };
  h.voice.stop();
  expect(h.inserted).toEqual(['existing words']);
  expect(h.voice.isRecording).toBe(false);
  expect(h.timers.size).toBe(0);
});
test('cleanup during finishing releases recognition and cannot insert a second result', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  stopResult(h.voice, 'keep these words', false);
  h.voice.stop();
  h.voice.cleanup();
  expect(h.voice.isRecording).toBe(false);
  expect(h.timers.size).toBe(0);
  stopResult(h.voice, 'stale result');
  h.voice._onWebSpeechEnd();
  expect(h.inserted).toEqual(['keep these words']);
  expect(h.voice.recognition).toBe(null);
});
test('fatal browser error ends immediately without retrying or dropping existing words', () => {
  const h = stopHarness();
  h.voice._startWebSpeech();
  stopResult(h.voice, 'existing words', false);
  h.voice._onWebSpeechError({ error: 'network' });
  h.voice._onWebSpeechEnd();
  expect(h.voice.isRecording).toBe(false);
  expect(h.inserted).toEqual(['existing words']);
  expect(h.starts).toBe(1);
  expect(h.timers.size).toBe(0);
  expect(h.toasts[0]).toMatch(/internet/);
});
