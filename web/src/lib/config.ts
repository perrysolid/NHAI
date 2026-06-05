/**
 * config.ts — single source of truth for the WEB demo (mirrors the native app's
 * src/config.ts in intent). Thresholds, flags, liveness rules, backend URL.
 *
 * The web demo uses @vladmandic/face-api (browser) for detection + 128-d
 * descriptors + expressions. The native app uses EdgeFace + MiniFASNet on-device;
 * both share the same flow and gate semantics.
 */

export const FLAGS = {
  /** When true, sync is simulated locally (no backend needed) so the demo works
   *  offline / before the Render backend is deployed. Toggle in the UI. */
  MOCK_SYNC: true,
} as const;

// ── Recognition (face-api descriptors are 128-d; match by Euclidean distance) ──
export const RECOGNITION = {
  descriptorLength: 128,
  /** Euclidean distance BELOW this = same person. face-api norm ~0.6 default;
   *  0.5 is a stricter, demo-friendly choice. */
  matchDistance: 0.5,
  /** Captures averaged into one enrollment template. */
  enrollSamples: 5,
} as const;

// ── Quality gates (browser coordinates, normalized to video size) ──
export const GATES = {
  /** min face box width / video width. */
  minFaceRatio: 0.18,
  /** max absolute head yaw/pitch estimate (degrees) for a frontal capture. */
  maxYawDeg: 30,
  maxPitchDeg: 30,
  /** mean luma 0..255 of the sampled frame. */
  minBrightness: 55,
  maxBrightness: 235,
} as const;

// ── Liveness (active challenge defeats static photo spoofs) ──
export const LIVENESS = {
  /** face-api 'happy' expression probability for a smile. */
  smileProb: 0.7,
  /** Eye Aspect Ratio: below = closed, above = open (blink = closed->open). */
  earClosed: 0.21,
  earOpen: 0.28,
  /** yaw delta (deg) to count a head turn. */
  headTurnDeltaDeg: 18,
  /** whole active challenge must complete within this window. */
  timeoutMs: 7000,
  /** how many distinct challenges to require (randomized). */
  challengeCount: 2,
} as const;

// ── Drowsiness / attention monitoring (eye-landmark based) ──
export const DROWSINESS = {
  /** EAR below this = eyes considered closed for PERCLOS/blink. */
  earClosed: 0.21,
  /** rolling window (ms) over which PERCLOS and blink rate are computed. */
  windowMs: 15000,
  /** PERCLOS (fraction of window with eyes closed) at/above this = drowsy. */
  perclosDrowsy: 0.2,
  /** a single continuous eye closure this long (ms) = drowsy (micro-sleep). */
  sustainedClosureMs: 1100,
  /** |yaw| beyond this (deg) = subject looking away / inattentive. */
  lookAwayYawDeg: 26,
  /** blinks per minute above this = elevated (fatigue indicator). */
  highBlinkRate: 28,
} as const;

// ── Sync target (Render backend). Override via VITE_SYNC_URL at build time. ──
export const SYNC = {
  url:
    (import.meta.env?.VITE_SYNC_URL as string | undefined) ??
    'http://localhost:4000',
  /** shared secret sent as x-api-key. */
  apiKey: (import.meta.env?.VITE_SYNC_KEY as string | undefined) ?? 'CHANGE_ME',
} as const;

export const config = {FLAGS, RECOGNITION, GATES, LIVENESS, DROWSINESS, SYNC};
export default config;
