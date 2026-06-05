/**
 * tts — offline voice prompts for the native app via react-native-tts (the
 * device's built-in TTS engine: Android TextToSpeech / iOS AVSpeechSynthesizer).
 * No network, no API key.
 *
 * Each prompt is a {hi, en} pair. We speak the selected language only if the
 * device actually has a voice for it; otherwise we fall back to English so the
 * user always hears something (a phone may not have a Hindi voice installed).
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

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
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

function say(lang: string, text: string): void {
  if (!text || text === lastSpoken) {
    return;
  }
  lastSpoken = text;
  // setDefaultLanguage rejects if the language pack is missing; fall back to
  // English text + voice so the prompt is always audible.
  Tts.setDefaultLanguage(lang)
    .then(() => {
      Tts.stop();
      Tts.speak(text);
    })
    .catch(() => undefined);
}

/** Speak a prompt; uses the selected language if available, else English. */
export function speak(pair: SpeechPair): void {
  if (!enabled || !pair) {
    return;
  }
  const lang = getLang();
  const primaryTag = lang === 'hi' ? 'hi-IN' : 'en-US';
  const primaryText = pair[lang];

  Tts.setDefaultLanguage(primaryTag)
    .then(() => {
      if (primaryText === lastSpoken) {
        return;
      }
      lastSpoken = primaryText;
      Tts.stop();
      Tts.speak(primaryText);
    })
    .catch(() => {
      // selected language not installed -> fall back to English
      say('en-US', pair.en);
    });
}
