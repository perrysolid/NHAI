/**
 * i18n — single-language UI text + speech for the native app (Hindi default,
 * English optional). Static dictionaries, fully offline. Mirrors the web demo.
 */
export type Lang = 'hi' | 'en';

let current: Lang = 'hi';

export function setLang(l: Lang): void {
  current = l;
}
export function getLang(): Lang {
  return current;
}
/** BCP-47 tag for the platform TTS engine. */
export function speechLang(): string {
  return current === 'hi' ? 'hi-IN' : 'en-IN';
}

interface Pair {
  hi: string;
  en: string;
}
export function pick(p: Pair): string {
  return p[current];
}

export const GATE_TEXT: Record<string, Pair> = {
  ok: {hi: 'तैयार - नीचे बटन दबाएँ', en: 'Ready - tap the button below'},
  no_face: {hi: 'चेहरा बीच में रखें', en: 'Center your face'},
  multiple_faces: {hi: 'केवल एक व्यक्ति', en: 'One person only'},
  too_far: {hi: 'थोड़ा पास आएँ', en: 'Move a little closer'},
  off_angle: {hi: 'सीधा देखें', en: 'Look straight ahead'},
  too_dark: {hi: 'रोशनी बढ़ाएँ', en: 'Find better light'},
  too_bright: {hi: 'चमक कम करें', en: 'Reduce glare'},
};

export const LIVENESS_TEXT: Record<string, Pair> = {
  blink: {hi: 'पलक झपकाएँ', en: 'Blink your eyes'},
  smile: {hi: 'मुस्कुराएँ', en: 'Smile'},
  turn: {hi: 'सिर घुमाएँ', en: 'Turn your head'},
  passed: {hi: 'सत्यापित', en: 'Liveness confirmed'},
  failed: {hi: 'विफल, पुनः प्रयास करें', en: 'Liveness failed, retry'},
};
