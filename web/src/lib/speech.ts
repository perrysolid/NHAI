/**
 * speech — bilingual voice prompts via the browser's built-in Web Speech API
 * (speechSynthesis). No API key, no network: it uses the device's installed
 * voices, so it works offline like the rest of the auth flow.
 *
 * Prompts are "English / हिन्दी" strings; we speak the English part as en-IN and
 * the Hindi part as hi-IN (falling back to the default voice if hi-IN is absent).
 *
 * Chrome only lets speechSynthesis play once it has been "unlocked" inside a
 * real user gesture, so primeSpeech() must be called from a click/tap handler
 * before prompts fired from the frame loop will be audible.
 */
import {speechLang} from './i18n';

let enabled = false;
let lastSpoken = '';
let unlocked = false;

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Warm the voices list (it is async on first load).
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
      const u = new SpeechSynthesisUtterance(' ');
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
    voices.find(v => v.lang.replace('_', '-').startsWith(base))
  );
}

/** Speak a (possibly bilingual) prompt once; repeated identical text is ignored. */
export function speak(text: string): void {
  if (!enabled || !isSpeechSupported() || !text) {
    return;
  }
  if (text === lastSpoken) {
    return;
  }
  lastSpoken = text;
  const synth = window.speechSynthesis;
  synth.cancel();
  synth.resume();

  const lang = speechLang();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const v = voiceForLang(lang);
  if (v) {
    u.voice = v;
  }
  u.rate = 0.98;
  u.pitch = 1;
  u.volume = 1;
  synth.speak(u);
}
