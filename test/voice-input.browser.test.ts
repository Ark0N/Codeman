// Real Chromium rendering/input; native Android/Windows recognition is simulated.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { beforeAll, afterAll, it } from 'vitest';
const source = readFileSync(new URL('../src/web/public/voice-input.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf8');
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});
it.each([
  [390, 'Android', 'Mozilla/5.0 (Linux; Android 15) Chrome/141.0'],
  [820, 'Linux', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0'],
  [1292, 'Windows', 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0'],
] as const)('dictation at %ipx (%s)', async (width, platform, ua) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true, userAgent: ua });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(
    '<button id="mic" style="position:fixed;top:20px;left:20px">Microphone</button><div class="voice-compose-overlay"><textarea class="paste-textarea" aria-label="Transcript"></textarea></div>'
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({
    content: `const platform = ${JSON.stringify(platform)};
   Object.defineProperty(navigator,'userAgentData',{value:{platform},configurable:true});
   Object.defineProperty(navigator,'platform',{value:platform==='Windows'?'Win32':'Linux x86_64',configurable:true});
   window.micRequests=0;
   Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia(){window.micRequests++;return Promise.reject(Error('Unexpected second microphone'));}},configurable:true});
   window.SpeechRecognition=class{
    start(){this.results=[];}
    partial(text){this.text=text;const r=Object.assign([{transcript:text}],{isFinal:platform!=='Windows'&&this.continuous});if(r.isFinal)this.results.push(r);else this.results=[r];this.onresult({resultIndex:r.isFinal?this.results.length-1:0,results:this.results});}
    final(text){this.text=text;const r=Object.assign([{transcript:text}],{isFinal:true});if(platform!=='Windows'&&this.continuous)this.results.push(r);else this.results=[r];this.onresult({resultIndex:0,results:this.results});}
    stop(){setTimeout(()=>{this.final(this.text);this.onend();},50);}
    abort(){}
   };
   window.app={activeSessionId:'fixture',showToast(){}};
`,
  });
  await page.addScriptTag({
    content:
      source +
      `\nwindow.voice=VoiceInput;VoiceInput._getDeepgramConfig=()=>({provider:'webspeech',insertMode:'compose',silenceTimeout:0});document.getElementById('mic').onclick=()=>VoiceInput.toggle();`,
  });
  await page.click('#mic');
  assert.equal(await page.evaluate(() => (window as any).voice.recognition.continuous), platform === 'Windows');
  await page.evaluate(() => (window as any).voice.recognition.onsoundstart());
  await page.waitForFunction(() => document.querySelectorAll('.voice-level-bar.active').length > 0);
  const counts = new Set();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(90);
    counts.add(await page.locator('.voice-level-bar.active').count());
  }
  assert.ok(counts.size > 1, 'speech bars must animate');
  await page.evaluate(() => (window as any).voice.recognition.onsoundend());
  await page.waitForFunction(() => document.querySelectorAll('.voice-level-bar.active').length === 0);
  await page.evaluate(() => {
    const voice = (window as any).voice;
    for (const text of ['one', 'one two', 'one two three', 'one two three four', 'one two three four five'])
      voice.recognition.partial(text);
    voice.recognition.final('one two three four five');
  });
  assert.equal(
    await page.evaluate(() => (window as any).voice._previewTextNode.textContent),
    'one two three four five'
  );
  await page.click('#mic');
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'one two three four five');
  assert.equal(await page.evaluate(() => (window as any).voice.isRecording), false);
  await page.click('#mic');
  await page.evaluate(() => {
    const voice = (window as any).voice;
    voice.recognition.final('go go');
    voice.recognition.onend();
    voice.recognition.partial('go go');
  });
  await page.click('#mic');
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'go go go go');
  assert.equal(await page.evaluate(() => (window as any).micRequests), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
