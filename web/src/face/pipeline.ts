/**
 * pipeline — thin wrapper over face-api detection.
 *
 *  - observe(): fast per-frame signals for gating + liveness (no descriptor)
 *  - computeDescriptor(): 128-d recognition descriptor at capture time
 *
 * Keeping descriptor extraction out of the live loop keeps the preview smooth.
 */
import * as faceapi from '@vladmandic/face-api';
import {
  averageEAR,
  estimatePitchDeg,
  estimateYawDeg,
  type Box,
  type Pt,
} from './geometry';

export type VisionInput =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement;

export interface FaceSignals {
  box: Box;
  score: number;
  /** 'happy' expression probability (smile). */
  happy: number;
  /** eye aspect ratio (blink detection). */
  ear: number;
  yawDeg: number;
  pitchDeg: number;
}

export interface Observation {
  faceCount: number;
  primary: FaceSignals | null;
}

// Live preview/gating: lighter for a smooth frame loop.
const detectorOptions = new faceapi.TinyFaceDetectorOptions({
  inputSize: 320,
  scoreThreshold: 0.5,
});
// Recognition capture: higher input resolution + lower score threshold for more
// accurate landmarks and descriptors (more robust on real-world / Indian faces).
const captureOptions = new faceapi.TinyFaceDetectorOptions({
  inputSize: 416,
  scoreThreshold: 0.4,
});

function toPts(points: faceapi.Point[]): Pt[] {
  return points.map(p => ({x: p.x, y: p.y}));
}

function signalsFrom(
  detection: faceapi.FaceDetection,
  landmarks: faceapi.FaceLandmarks68,
  expressions: faceapi.FaceExpressions,
): FaceSignals {
  const leftEye = toPts(landmarks.getLeftEye());
  const rightEye = toPts(landmarks.getRightEye());
  const nose = toPts(landmarks.getNose());
  const noseTip = nose[nose.length - 1] ?? nose[3];
  const b = detection.box;
  const box: Box = {x: b.x, y: b.y, width: b.width, height: b.height};
  const expr = expressions as unknown as Record<string, number>;
  return {
    box,
    score: detection.score,
    happy: expr.happy ?? 0,
    ear: averageEAR(leftEye, rightEye),
    yawDeg: estimateYawDeg(leftEye, rightEye, noseTip),
    pitchDeg: estimatePitchDeg(leftEye, rightEye, noseTip, box),
  };
}

export async function observe(input: VisionInput): Promise<Observation> {
  const results = await faceapi
    .detectAllFaces(input, detectorOptions)
    .withFaceLandmarks()
    .withFaceExpressions();
  if (results.length === 0) {
    return {faceCount: 0, primary: null};
  }
  // Largest face is the subject.
  const r = results.reduce((a, c) =>
    a.detection.box.area > c.detection.box.area ? a : c,
  );
  return {
    faceCount: results.length,
    primary: signalsFrom(r.detection, r.landmarks, r.expressions),
  };
}

export async function computeDescriptor(
  input: VisionInput,
): Promise<Float32Array | null> {
  const res = await faceapi
    .detectSingleFace(input, captureOptions)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return res?.descriptor ?? null;
}
