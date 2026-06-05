/**
 * tts — offline voice prompts for the native app via react-native-tts (the
 * device's built-in TTS engine: Android TextToSpeech / iOS AVSpeechSynthesizer).
 * No network, no API key.
 *
 * Each prompt is a {hi, en} pair. We speak the selected language (default Hindi)
 * and only fall back to English when the device is CONFIRMED to have no voice
 * for that language. Speaking is synchronous — we never block on an async
 * setDefaultLanguage promise, so a prompt is always spoken.
 *
 * Requires a native rebuild after install (autolinking handles the native side).
 */
import Tts from 'react-native-tts';
import {getLang} from '../i18n';

export interface SpeechPair {
  hi: string;
  en: string;
}

let enabled = true;
let lastSpoken = '';

// Cached list of installed voice language tags (lowercased), loaded async once.
let installedLangs: string[] = [];
let voicesKnown = false;

function loadVoices(): void {
  try {
    Tts.voices()
      .then(list => {
        installedLangs = (list || [])
          .filter(v => !v.notInstalled)
          .map(v => String(v.language || '').toLowerCase());
        voicesKnown = installedLangs.length > 0;
      })
      .catch(() => {
        voicesKnown = false;
      });
  } catch {
    voicesKnown = false;
  }
}
loadVoices();

/** True if a voice for the base language is installed, OR if unknown (we then
 *  optimistically attempt the selected language rather than stay silent). */
function hasVoice(base: 'hi' | 'en'): boolean {
  if (!voicesKnown) {
    return true;
  }
  return installedLangs.some(l => l.startsWith(base));
}

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (on) {
    loadVoices();
  } else {
    try {
      Tts.stop();
    } catch {
      /* ignore */
    }
  }
  lastSpoken = '';
}

export function isSpeechEnabled(): boolean {
  return enabled;
}

/** Speak a prompt; selected language if it has a voice, else English. */
export function speak(pair: SpeechPair): void {
  if (!enabled || !pair) {
    return;
  }
  const lang = getLang();
  let use: 'hi' | 'en' = lang;
  if (lang === 'hi' && !hasVoice('hi') && hasVoice('en')) {
    use = 'en';
  }
  const text = pair[use];
  if (!text || text === lastSpoken) {
    return;
  }
  lastSpoken = text;
  try {
    Tts.stop();
    // fire-and-forget: do NOT await, so we always speak even if this rejects
    Tts.setDefaultLanguage(use === 'hi' ? 'hi-IN' : 'en-US').catch(
      () => undefined,
    );
    Tts.speak(text);
  } catch {
    /* TTS engine unavailable; fail silent */
  }
}
