/**
 * speech — bilingual voice prompts via the browser's built-in Web Speech API
 * (speechSynthesis). No API key, no network: it uses the device's installed
 * voices, so it works offline like the rest of the auth flow.
 *
 * Prompts are "English / हिन्दी" strings; we speak the English part as en-IN and
 * the Hindi part as hi-IN (falling back to the default voice if hi-IN is absent).
 */
let enabled = false;
let lastSpoken = '';

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
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

function voiceForLang(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.split('-')[0];
  return (
    voices.find(v => v.lang === lang) ||
    voices.find(v => v.lang.startsWith(base))
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

  const parts = text
    .split('/')
    .map(s => s.trim())
    .filter(Boolean);
  const langs = ['en-IN', 'hi-IN'];
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    u.lang = langs[i] ?? 'en-IN';
    const v = voiceForLang(u.lang);
    if (v) {
      u.voice = v;
    }
    u.rate = 1;
    u.pitch = 1;
    synth.speak(u);
  });
}
