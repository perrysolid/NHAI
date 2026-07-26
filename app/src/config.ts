/**
 * config.ts — SINGLE SOURCE OF TRUTH for model specs, thresholds and flags.
 *
 * Rule: never hardcode model dimensions / normalization / thresholds inside
 * worklets or screens. Read them from here so EdgeFace <-> MobileFaceNet and
 * tflite <-> onnx are one-line swaps, and so judges/teammates can tune the
 * pipeline without hunting through the codebase.
 *
 * ALWAYS verify each model's real input/output in https://netron.app BEFORE
 * trusting these numbers — wrong dtype/shape/normalization is the #1 runtime bug.
 */

import type {Site} from './location/types';
import {SYNC_URL, SYNC_API_KEY} from './secrets';

// ────────────────────────────────────────────────────────────────────────────
// Feature flags
// ────────────────────────────────────────────────────────────────────────────
export const FLAGS = {
  /** When true, sync POSTs are simulated (200 OK) so the offline demo can show
   *  the sync→purge lifecycle without a live backend. Now wired to the live
   *  Render backend, so real POSTs go out. */
  MOCK_MODE: false,
  /** When false, fall back to still-image inference (runOnImage) instead of
   *  live camera frames — a Plan B if live frame processing misbehaves. */
  USE_LIVE_FRAMES: true,
  /** Verbose per-stage latency logging to Metro console. */
  LOG_LATENCY: true,
  /** Strict mode: verify requires the passive score to clear THRESHOLDS
   *  .livenessPassive (a hard AND with the active challenge). Off by default. */
  REQUIRE_PASSIVE_LIVENESS: false,
  /** Screen/print-replay defence: reject when the passive MiniFASNet score is
   *  CONFIDENTLY low (< THRESHOLDS.livenessPassiveFloor) — this is what catches a
   *  video played on a second phone (a screen has texture/moiré a live face
   *  doesn't). Soft floor (not the full 0.5 threshold) so a real face near the
   *  boundary isn't false-rejected. Calibrate the floor on-device before relying
   *  on it; flip false if it rejects real faces. */
  PASSIVE_SCREEN_BLOCK: true,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Recognition model (swappable engine)
// ────────────────────────────────────────────────────────────────────────────
export type RecognitionModelId = 'edgeface_s' | 'mobilefacenet';

/** Active recognition model — swap this one line to change the engine. */
export const ACTIVE_RECOGNITION: RecognitionModelId = 'mobilefacenet';

export interface RecognitionSpec {
  /** require()'d asset, resolved lazily in FaceEngine to keep config pure. */
  assetName: string;
  inputSize: number; // square: inputSize x inputSize
  channels: 3;
  /** per-channel normalization: (pixel/255 - mean) / std */
  mean: [number, number, number];
  std: [number, number, number];
  embeddingLength: number;
  dtype: 'float32' | 'uint8';
  /** Face-box expansion for the recognition crop. Recognition models want a
   *  tight, roughly-aligned face; ~1.25x the detector box gives forehead-to-chin
   *  without background. Never feed a full-frame center-crop — that was the root
   *  cause of "recognition doesn't match": the model embedded the whole scene. */
  cropExpansion: number;
}

export const RECOGNITION_MODELS: Record<RecognitionModelId, RecognitionSpec> = {
  // EdgeFace-S (George et al., TBIOM 2024 — IJCB'23 compact-track winner).
  // 99.73% LFW @ 1.77M params. Align face -> 112x112, normalize mean/std 0.5.
  edgeface_s: {
    assetName: 'edgeface_s.tflite',
    inputSize: 112,
    channels: 3,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    embeddingLength: 512,
    dtype: 'float32',
    cropExpansion: 1.25,
  },
  // MobileFaceNet — bundled compact runnable recognition model. The previous
  // FaceNet-512 option was runnable but ~45 MB, so it is intentionally not
  // bundled for the NHAI lightweight target.
  mobilefacenet: {
    assetName: 'mobilefacenet.tflite',
    inputSize: 112,
    channels: 3,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    embeddingLength: 192,
    dtype: 'float32',
    cropExpansion: 1.25,
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Liveness model (passive anti-spoof)
// ────────────────────────────────────────────────────────────────────────────
export interface LivenessSpec {
  assetName: string;
  inputSize: number;
  channels: 3;
  /** per-channel normalization: (pixel/255 - mean) / std */
  mean: [number, number, number];
  std: [number, number, number];
  /** MiniFASNet is trained on a crop ~2.7x the face bbox. */
  bboxExpansion: number;
  /** softmax index that means "real/live". */
  liveClassIndex: number;
  dtype: 'float32' | 'uint8';
  /** Channel order the model expects. Silent-Face / MiniFASNet was trained on
   *  OpenCV (BGR) images, so 'bgr' is the correct default — a mismatch here is
   *  the most likely reason the passive score looked unreliable. Calibrate on a
   *  device: a real face should score high, a phone-screen replay low. */
  channelOrder: 'rgb' | 'bgr';
}

// MiniFASNetV2-SE (Silent-Face-Anti-Spoofing, Apache-2.0).
// Input 80x80x3, 3-class softmax, index 1 = live.
export const LIVENESS_MODEL: LivenessSpec = {
  assetName: 'minifasnet.tflite',
  inputSize: 80,
  channels: 3,
  mean: [0, 0, 0],
  std: [1, 1, 1],
  bboxExpansion: 2.7,
  liveClassIndex: 1,
  dtype: 'float32',
  channelOrder: 'bgr',
};

// ────────────────────────────────────────────────────────────────────────────
// Thresholds & gates
// ────────────────────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  /** Cosine similarity >= this means the same person. */
  recognitionCosine: 0.55,
  /** Passive anti-spoof "live" probability must exceed this. Only enforced when
   *  FLAGS.REQUIRE_PASSIVE_LIVENESS is true; otherwise it is advisory (recorded
   *  but non-blocking) so an uncalibrated MiniFASNet can't false-reject a real
   *  face. The active motion challenge is the primary defeat-a-photo mechanism. */
  livenessPassive: 0.5,
  /** Screen-replay floor (see FLAGS.PASSIVE_SCREEN_BLOCK). Reject only when the
   *  passive "live" probability is CONFIDENTLY below this — obvious screens score
   *  low, real faces well above. Conservative so a borderline real face passes. */
  livenessPassiveFloor: 0.3,
  /** Minimum range the eye-open signal must span during a verify attempt — a
   *  real blink swings ~0.8; a held photo stays flat. Defeats static spoofs. */
  livenessMotionRange: 0.2,
  /** How many random motion actions the verify challenge requires, out of
   *  blink/smile/turn. 3 asks for all of them (in a random order each
   *  attempt) — matches the poses captured at enrollment (see ENROLL_STEPS in
   *  screens/CameraScreen.tsx) for a full device-Face-ID-style challenge. */
  livenessActionCount: 3,
  /** Active-challenge window — shared across all `livenessActionCount`
   *  actions in one attempt, so it scales with the count: generous enough
   *  that a real user isn't rushed even asking for all 3. */
  activeChallengeTimeoutMs: 30000,
  /** Quality gates — advisory guidance, kept forgiving for field use. Loosened
   *  so the "face centered" ready state (which drives hands-free auto-capture /
   *  auto-verify) triggers readily; only a clear profile, a tiny/distant face,
   *  or near-black / blown-out frames still block. */
  maxYawDeg: 45,
  maxPitchDeg: 45,
  minFaceRatio: 0.09, // face bbox width / frame width
  minBrightness: 25, // mean luma 0..255
  maxBrightness: 252,
  /** Active-liveness landmark cutoffs (ML Kit probabilities 0..1). Loosened so a
   *  natural blink / smile / turn registers reliably on mid-range cameras. */
  blinkClosedProb: 0.4,
  blinkOpenProb: 0.6,
  smileProb: 0.5,
  headTurnDeltaDeg: 12,
  /** A synced record is flagged livenessPassed when its passive score clears
   *  this. Kept in config so the device and backend agree on one number. */
  livenessSyncPass: 0.7,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Drowsiness / attention monitoring (eye-landmark based, on-device)
// ────────────────────────────────────────────────────────────────────────────
export const DROWSINESS = {
  earClosed: 0.21,
  windowMs: 15000,
  perclosDrowsy: 0.2,
  sustainedClosureMs: 1100,
  lookAwayYawDeg: 26,
  highBlinkRate: 28,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Composite authentication score — weighted aggregate of all signals (0..100)
// ────────────────────────────────────────────────────────────────────────────
export const SCORING = {
  weights: {
    recognition: 0.45,
    liveness: 0.25,
    alertness: 0.1,
    pose: 0.1,
    illumination: 0.1,
  },
  reviewBelow: 70,
  /** Logistic steepness mapping cosine similarity → 0..1 confidence, centred on
   *  THRESHOLDS.recognitionCosine. Higher = sharper accept/reject transition. */
  confidenceSteepness: 12,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Camera / processing
// ────────────────────────────────────────────────────────────────────────────
export const CAMERA = {
  targetFps: 8, // frame-processor throttle (runAtTargetFps)
  /** The worklet downscales each frame to this longest-edge (px), preserving the
   *  full field of view (no center-crop), and hands that one RGB buffer to JS.
   *  JS then crops the aligned face from it (see camera/faceCrop.ts). Big enough
   *  that an 80–112 px face crop stays sharp; small enough to stay ~8 fps. */
  mediumLongEdge: 256,
  /** Hands-free auto-capture / auto-verify loop cadence and spacing. */
  autoLoopIntervalMs: 200,
  autoCaptureCooldownMs: 700,
  /** How long the "Enrollment saved" confirmation holds on the enroll camera
   *  screen before returning Home. A well-centered face can complete all 3
   *  samples in ~2s; without this pause the screen would flash and vanish
   *  before the operator ever sees a save confirmation. */
  enrollCompleteDelayMs: 1200,
  /** Active-liveness challenge polling cadence. */
  challengeTickMs: 160,
  /** How long the verify pass/fail result (big check/cross over the camera)
   *  holds before clearing back to the idle scanning state. */
  verifyResultHoldMs: 1800,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Sync (offline → online). NEVER referenced in the auth path.
// ────────────────────────────────────────────────────────────────────────────
export const SYNC = {
  /** Backend origin + device key are read from the GITIGNORED secrets file, so
   *  they aren't committed to source. `/api/enroll`, `/api/sync`, `/api/sites/…`
   *  all derive from SYNC_URL's origin. See secrets.example.ts. */
  url: SYNC_URL,
  apiKey: SYNC_API_KEY,
  batchSize: 50,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Geofencing (on-device "is the worker at the assigned site?"). Fully offline —
// GPS is satellite-based; the site list lives on the device. NEVER in the auth
// decision for identity; it's an independent presence signal on the record.
// ────────────────────────────────────────────────────────────────────────────
export const GEOFENCE = {
  /** Reject GPS fixes whose horizontal accuracy radius exceeds this (metres). */
  maxAccuracyM: 50,
  /** Fail the geofence when the OS flags the fix as a mock / fake-GPS provider. */
  rejectMocked: true,
  /** When true a verify OUTSIDE the geofence (or mocked) is BLOCKED, not just
   *  flagged. Keep false until SITES holds a real site at your demo location,
   *  otherwise every verify fails the geofence. */
  enforce: false,
  /** getCurrentPosition timeout (ms) and how stale a cached fix may be (ms). */
  fixTimeoutMs: 8000,
  maxFixAgeMs: 15000,
} as const;

/**
 * Provisioned work sites, stored ON-DEVICE (no network). Replace the demo entry
 * with the real assigned site(s). For a live demo, set `center` to your current
 * lat/lon (from Google Maps) and a radius that comfortably covers the room, then
 * flip GEOFENCE.enforce to true.
 */
export const SITES: Site[] = [
  {
    id: 'demo-site',
    name: 'Demo Site',
    shape: {
      kind: 'circle',
      // TODO: set to the demo location's coordinates before enforcing.
      center: {lat: 28.6139, lon: 77.209},
      radiusM: 150,
    },
  },
];

export const config = {
  FLAGS,
  ACTIVE_RECOGNITION,
  RECOGNITION_MODELS,
  LIVENESS_MODEL,
  THRESHOLDS,
  DROWSINESS,
  SCORING,
  CAMERA,
  SYNC,
  GEOFENCE,
  SITES,
};

export default config;
