/**
 * speech — bilingual voice prompts via the browser's built-in Web Speech API.
 *
 * Pure speechSynthesis — no API keys, no network, no server. Uses whatever
 * voices the device has installed, works fully offline.
 *
 * Bugs fixed from the original:
 *  - Dedup uses a 2s cooldown instead of permanent "never repeat" which was
 *    silencing liveness prompts on subsequent challenges.
 *  - 60ms gap between cancel() and speak() to avoid Chrome's race condition
 *    where the new utterance gets silently dropped.
 *  - Force-resume after speak() to recover from Chrome's "stuck paused" bug.
 *  - Voices are polled until loaded (Chrome loads them asynchronously).
 */
import {getLang} from './i18n';

export interface SpeechPair {
  hi: string;
  en: string;
}

let enabled = false;
let unlocked = false;
let lastText = '';
let lastTime = 0;

const DEDUP_MS = 2000; // same text within 2s is suppressed

/* ─── support check ─── */

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function isSpeechEnabled(): boolean {
  return enabled;
}

/* ─── warm voices (they load async in Chrome) ─── */

if (isSpeechSupported()) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    const v = window.speechSynthesis.getVoices();
    console.log('[TTS] voiceschanged —', v.length, 'voices available');
  });
  // Fallback poll for browsers that never fire voiceschanged
  const poll = setInterval(() => {
    const v = window.speechSynthesis.getVoices();
    if (v.length > 0) {
      console.log('[TTS] voices ready:', v.length);
      clearInterval(poll);
    }
  }, 200);
  setTimeout(() => clearInterval(poll), 5000);
}

/* ─── enable / disable ─── */

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (!on && isSpeechSupported()) {
    window.speechSynthesis.cancel();
  }
  lastText = '';
  lastTime = 0;
}

/* ─── unlock (MUST be called from a click/tap handler) ─── */

export function primeSpeech(): void {
  if (!isSpeechSupported()) return;
  try {
    const synth = window.speechSynthesis;
    synth.resume();
    if (!unlocked) {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      u.lang = 'en-US';
      synth.speak(u);
      unlocked = true;
      console.log('[TTS] unlocked via user gesture');
    }
  } catch (e) {
    console.warn('[TTS] primeSpeech error:', e);
  }
}

/* ─── voice helpers ─── */

function pickVoice(base: 'hi' | 'en'): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const bcp = base === 'hi' ? 'hi-IN' : 'en-IN';
  return (
    voices.find(v => v.lang === bcp) ||
    voices.find(v => v.lang.replace('_', '-').toLowerCase().startsWith(base)) ||
    // last resort — any English voice
    (base !== 'en' ? undefined : voices.find(v => v.lang.startsWith('en')))
  );
}

function hasVoice(base: 'hi' | 'en'): boolean {
  return window.speechSynthesis
    .getVoices()
    .some(v => v.lang.replace('_', '-').toLowerCase().startsWith(base));
}

/* ─── speak ─── */

export function speak(pair: SpeechPair | string): void {
  if (!enabled || !isSpeechSupported()) return;

  const p: SpeechPair = typeof pair === 'string' ? {hi: pair, en: pair} : pair;
  const selected = getLang(); // 'hi' | 'en'

  // Pick language with installed voice, fall back so it's never silent.
  let use: 'hi' | 'en';
  if (selected === 'hi') {
    use = hasVoice('hi') ? 'hi' : 'en';
  } else {
    use = hasVoice('en') ? 'en' : hasVoice('hi') ? 'hi' : 'en';
  }

  const text = p[use];
  if (!text) return;

  // Cooldown dedup — allow repeats after 2s.
  const now = Date.now();
  if (text === lastText && now - lastTime < DEDUP_MS) return;
  lastText = text;
  lastTime = now;

  const synth = window.speechSynthesis;
  synth.cancel();
  synth.resume();

  // 60ms gap after cancel() — Chrome drops the utterance if you speak() too fast.
  setTimeout(() => {
    if (!enabled) return;

    const bcp = use === 'hi' ? 'hi-IN' : 'en-IN';
    const u = new SpeechSynthesisUtterance(text);
    u.lang = bcp;
    const v = pickVoice(use);
    if (v) u.voice = v;
    u.rate = 0.95;
    u.pitch = 1;
    u.volume = 1;

    u.onstart = () => console.log('[TTS] speaking:', text.slice(0, 40));
    u.onerror = (ev) => console.warn('[TTS] error:', ev.error);

    synth.speak(u);

    // Chrome bug: synth gets stuck in "paused" state. Force-resume.
    setTimeout(() => {
      if (synth.paused) {
        synth.resume();
        console.log('[TTS] force-resumed');
      }
    }, 120);
  }, 60);
}
