/**
 * tts — offline voice prompts for the native app via react-native-tts, which
 * wraps the device's built-in TTS engine (Android TextToSpeech / iOS
 * AVSpeechSynthesizer). No network, no API key. Language follows the i18n
 * selection (Hindi default, English optional).
 *
 * Requires a native rebuild after install (autolinking handles the native side).
 */
import Tts from 'react-native-tts';
import {speechLang} from '../i18n';

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

/** Speak a prompt in the active language; repeated identical text is ignored. */
export function speak(text: string): void {
  if (!enabled || !text || text === lastSpoken) {
    return;
  }
  lastSpoken = text;
  try {
    Tts.stop();
    Tts.setDefaultLanguage(speechLang()).catch(() => undefined);
    Tts.speak(text);
  } catch {
    /* TTS engine unavailable; fail silent */
  }
}
