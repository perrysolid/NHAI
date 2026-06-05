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

const GUIDANCE: Record<GateStatus, string> = {
  ok: 'Hold still…',
  no_face: 'Center your face in the circle',
  multiple_faces: 'Only one person in frame',
  too_far: 'Move a little closer',
  off_angle: 'Look straight at the camera',
  too_dark: 'Too dark — find better light',
  too_bright: 'Too bright — reduce glare',
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
