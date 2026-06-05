/**
 * tts — offline voice prompts via react-native-tts (the device's built-in TTS
 * engine: Android TextToSpeech / iOS AVSpeechSynthesizer). No network, no key.
 *
 * Simple and synchronous: initialise the engine once, then speak the selected
 * language (default Hindi), falling back to the English text if the prompt has
 * no Hindi string. Speaking never awaits a promise, so a prompt is always said.
 */
import Tts from 'react-native-tts';
import {getLang} from '../i18n';

export interface SpeechPair {
  hi: string;
  en: string;
}

let enabled = true;
let lastSpoken = '';
let initialised = false;

/** Initialise the TTS engine. On Android, speak() is silent until this runs. */
function init(): void {
  if (initialised) {
    return;
  }
  initialised = true;
  try {
    Tts.getInitStatus()
      .then(() => {
        Tts.setDefaultRate(0.5).catch(() => undefined);
        Tts.setDefaultPitch(1.0).catch(() => undefined);
      })
      .catch((err: unknown) => {
        const code = (err as {code?: string} | null)?.code;
        if (code === 'no_engine') {
          Tts.requestInstallEngine().catch(() => undefined);
        }
      });
  } catch {
    /* ignore */
  }
}
init();

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (on) {
    init();
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

/** Speak a prompt in the selected language (default Hindi). */
export function speak(pair: SpeechPair): void {
  if (!enabled || !pair) {
    return;
  }
  const lang = getLang();
  const tag = lang === 'hi' ? 'hi-IN' : 'en-US';
  const text = pair[lang] || pair.en;
  if (!text || text === lastSpoken) {
    return;
  }
  lastSpoken = text;
  try {
    Tts.stop();
    Tts.setDefaultLanguage(tag).catch(() => undefined);
    Tts.speak(text);
  } catch {
    /* TTS engine unavailable; fail silent */
  }
}
