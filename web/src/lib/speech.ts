/**
 * speech — bilingual voice prompts via the browser's built-in Web Speech API
 * (speechSynthesis). No API key, no network: it uses the device's installed
 * voices, so it works offline like the rest of the auth flow.
 *
 * Each prompt is a {hi, en} pair. We speak the selected language ONLY if a voice
 * for it is installed; otherwise we fall back to the other language so the user
 * always hears something. (Most laptops ship an English voice but no Hindi one,
 * which is why selecting Hindi could be silent.)
 *
 * Chrome only lets speechSynthesis play once it has been "unlocked" inside a
 * real user gesture, so primeSpeech() must be called from a click/tap handler.
 */
import {getLang} from './i18n';

export interface SpeechPair {
  hi: string;
  en: string;
}

let enabled = false;
let lastSpoken = '';
let unlocked = false;

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Warm the voices list (it loads asynchronously on first use).
if (isSpeechSupported()) {
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      window.speechSynthesis.getVoices();
    });
  } catch {
    /* ignore */
  }
}

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (!on && isSpeechSupported()) {
    window.speechSynthesis.cancel();
  }
  lastSpoken = '';
}

export function isSpeechEnabled(): boolean {
  return enabled;
}

/** Call from a click/tap handler to unlock audio so later prompts are audible. */
export function primeSpeech(): void {
  if (!isSpeechSupported()) {
    return;
  }
  try {
    const synth = window.speechSynthesis;
    synth.resume();
    if (!unlocked) {
      const u = new SpeechSynthesisUtterance('.');
      u.volume = 0;
      synth.speak(u);
      unlocked = true;
    }
  } catch {
    /* ignore */
  }
}

function voiceForLang(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.split('-')[0];
  return (
    voices.find(v => v.lang === lang) ||
    voices.find(v => v.lang.replace('_', '-').toLowerCase().startsWith(base))
  );
}

function hasVoice(base: 'hi' | 'en'): boolean {
  return window.speechSynthesis
    .getVoices()
    .some(v => v.lang.replace('_', '-').toLowerCase().startsWith(base));
}

/** Speak a prompt in a language that actually has an installed voice. */
export function speak(pair: SpeechPair | string): void {
  if (!enabled || !isSpeechSupported()) {
    return;
  }
  const p: SpeechPair = typeof pair === 'string' ? {hi: pair, en: pair} : pair;

  const selected = getLang(); // 'hi' | 'en'
  let use: 'hi' | 'en' = selected;
  if (selected === 'hi' && !hasVoice('hi') && hasVoice('en')) {
    use = 'en';
  } else if (selected === 'en' && !hasVoice('en') && hasVoice('hi')) {
    use = 'hi';
  }

  const text = p[use];
  if (!text || text === lastSpoken) {
    return;
  }
  lastSpoken = text;

  const synth = window.speechSynthesis;
  synth.cancel();
  synth.resume();
  const bcp = use === 'hi' ? 'hi-IN' : 'en-IN';
  const u = new SpeechSynthesisUtterance(text);
  u.lang = bcp;
  const v = voiceForLang(bcp);
  if (v) {
    u.voice = v;
  }
  u.rate = 0.98;
  u.pitch = 1;
  u.volume = 1;
  synth.speak(u);
}
