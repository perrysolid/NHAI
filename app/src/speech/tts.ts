/**
 * tts — offline voice prompts via react-native-tts (Android TextToSpeech /
 * iOS AVSpeechSynthesizer). No network, no API key — fully offline.
 *
 * Initialises the device TTS engine once, then speaks the selected language
 * (default Hindi). Falls back to English if no Hindi text is provided.
 *
 * Uses a 2s cooldown dedup (not permanent) so liveness prompts like "blink"
 * can repeat across challenges.
 */
import Tts from 'react-native-tts';
import {getLang} from '../i18n';

export interface SpeechPair {
  hi: string;
  en: string;
}

let enabled = true;
let lastText = '';
let lastTime = 0;
let initialised = false;

const DEDUP_MS = 2000;

/** Initialise the TTS engine. On Android, speak() is silent until this runs. */
function init(): void {
  if (initialised) return;
  initialised = true;
  try {
    Tts.getInitStatus()
      .then(() => {
        Tts.setDefaultRate(0.5).catch(() => undefined);
        Tts.setDefaultPitch(1.0).catch(() => undefined);
        // Pre-set to Hindi so the engine downloads the voice data early.
        Tts.setDefaultLanguage('hi-IN').catch(() => {
          // Hindi unavailable — English will be used as fallback.
          Tts.setDefaultLanguage('en-US').catch(() => undefined);
        });
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
  lastText = '';
  lastTime = 0;
}

export function isSpeechEnabled(): boolean {
  return enabled;
}

/** Speak a prompt in the selected language (default Hindi). */
export function speak(pair: SpeechPair): void {
  if (!enabled || !pair) return;

  const lang = getLang();
  const text = pair[lang] || pair.en;
  if (!text) return;

  // Cooldown dedup — allow repeats after 2s.
  const now = Date.now();
  if (text === lastText && now - lastTime < DEDUP_MS) return;
  lastText = text;
  lastTime = now;

  const tag = lang === 'hi' ? 'hi-IN' : 'en-US';
  try {
    Tts.stop();
    Tts.setDefaultLanguage(tag).catch(() => undefined);
    Tts.speak(text);
  } catch {
    /* TTS engine unavailable; fail silent */
  }
}
