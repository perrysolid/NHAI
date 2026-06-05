/**
 * qualityGates — pure functions that decide whether the current frame is good
 * enough to feed into liveness/recognition later.
 *
 * Kept dependency-free and pure so it's unit-testable and can run on the JS
 * thread after the worklet hands over {faces, brightness, frame size}.
 *
 * Order of checks matters: we surface the single most actionable instruction.
 */
import {THRESHOLDS} from '../config';
import type {Face, GateResult, GateStatus} from './types';

// Short bilingual guidance (English / हिन्दी) for field personnel. Static
// strings, so it works fully offline.
const GUIDANCE: Record<GateStatus, string> = {
  ok: 'Hold still / स्थिर रहें',
  no_face: 'Center your face / चेहरा बीच में रखें',
  multiple_faces: 'One person only / केवल एक व्यक्ति',
  too_far: 'Move closer / पास आएँ',
  off_angle: 'Look straight / सीधा देखें',
  too_dark: 'Too dark / रोशनी बढ़ाएँ',
  too_bright: 'Too bright / चमक कम करें',
};

function result(status: GateStatus): GateResult {
  return {status, guidance: GUIDANCE[status], ready: status === 'ok'};
}

export interface GateInput {
  faces: Face[];
  /** frame width in the same coordinate space as face.bounds. */
  frameWidth: number;
  /** mean luma 0..255 of the frame (or its downscaled proxy). */
  brightness: number;
}

export function evaluateFace({
  faces,
  frameWidth,
  brightness,
}: GateInput): GateResult {
  if (faces.length === 0) {
    return result('no_face');
  }
  if (faces.length > 1) {
    return result('multiple_faces');
  }

  const face = faces[0];

  // Distance: face must occupy enough of the frame width.
  const faceRatio = frameWidth > 0 ? face.bounds.width / frameWidth : 0;
  if (faceRatio < THRESHOLDS.minFaceRatio) {
    return result('too_far');
  }

  // Pose: roughly frontal within ±maxYaw / ±maxPitch degrees.
  if (
    Math.abs(face.yawAngle) > THRESHOLDS.maxYawDeg ||
    Math.abs(face.pitchAngle) > THRESHOLDS.maxPitchDeg
  ) {
    return result('off_angle');
  }

  // Lighting.
  if (brightness < THRESHOLDS.minBrightness) {
    return result('too_dark');
  }
  if (brightness > THRESHOLDS.maxBrightness) {
    return result('too_bright');
  }

  return result('ok');
}
