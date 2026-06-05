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

// ────────────────────────────────────────────────────────────────────────────
// Feature flags
// ────────────────────────────────────────────────────────────────────────────
export const FLAGS = {
  /** When true, sync POSTs are simulated (200 OK) so the offline demo can show
   *  the sync→purge lifecycle without a live backend. Default true. */
  MOCK_MODE: true,
  /** When false, fall back to still-image inference (runOnImage) instead of
   *  live camera frames — a Plan B if live frame processing misbehaves. */
  USE_LIVE_FRAMES: true,
  /** Verbose per-stage latency logging to Metro console. */
  LOG_LATENCY: true,
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
};

// ────────────────────────────────────────────────────────────────────────────
// Thresholds & gates
// ────────────────────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  /** Cosine similarity >= this means the same person. */
  recognitionCosine: 0.55,
  /** Passive anti-spoof "live" probability must exceed this (defense in depth
   *  against screen/print replays; the mandatory blink defeats static photos). */
  livenessPassive: 0.5,
  /** Minimum range the eye-open signal must span during a verify attempt — a
   *  real blink swings ~0.8; a held photo stays flat. Defeats static spoofs. */
  livenessMotionRange: 0.3,
  /** Active-challenge window (generous so real users complete all 3 actions). */
  activeChallengeTimeoutMs: 10000,
  /** Quality gates — advisory guidance, kept forgiving for field use. */
  maxYawDeg: 36,
  maxPitchDeg: 36,
  minFaceRatio: 0.12, // face bbox width / frame width
  minBrightness: 38, // mean luma 0..255
  maxBrightness: 245,
  /** Active-liveness landmark cutoffs (ML Kit probabilities 0..1). */
  blinkClosedProb: 0.35,
  blinkOpenProb: 0.65,
  smileProb: 0.6,
  headTurnDeltaDeg: 12,
  /** Enrollment captures averaged into one template. */
  enrollSamples: 3,
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
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Camera / processing
// ────────────────────────────────────────────────────────────────────────────
export const CAMERA = {
  targetFps: 8, // frame-processor throttle (runAtTargetFps)
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Sync (offline → online). NEVER referenced in the auth path.
// ────────────────────────────────────────────────────────────────────────────
export const SYNC = {
  /** AWS/Render-compatible endpoint. Filled in once the sync service is deployed. */
  url: 'https://YOUR-SYNC-ENDPOINT/api/sync',
  /** Shared secret sent as x-api-key. Move to secure storage for production. */
  apiKey: 'CHANGE_ME',
  batchSize: 50,
} as const;

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
};

export default config;
