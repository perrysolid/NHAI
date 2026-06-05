/**
 * gates — quality gates for the web pipeline. Mirrors the native app's
 * qualityGates: exactly one face, close enough, frontal, well-lit. Pure.
 */
import {GATES} from '../lib/config';
import type {Observation} from './pipeline';

export type GateStatus =
  | 'ok'
  | 'no_face'
  | 'multiple_faces'
  | 'too_far'
  | 'off_angle'
  | 'too_dark'
  | 'too_bright';

export interface GateResult {
  status: GateStatus;
  guidance: string;
  ready: boolean;
}

const GUIDANCE: Record<GateStatus, string> = {
  ok: 'Hold still…',
  no_face: 'Center your face in the circle',
  multiple_faces: 'Only one person in frame',
  too_far: 'Move a little closer',
  off_angle: 'Look straight at the camera',
  too_dark: 'Too dark — find better light',
  too_bright: 'Too bright — reduce glare',
};

function r(status: GateStatus): GateResult {
  return {status, guidance: GUIDANCE[status], ready: status === 'ok'};
}

export function evaluate(
  obs: Observation,
  videoWidth: number,
  brightness: number,
): GateResult {
  if (obs.faceCount === 0 || !obs.primary) {
    return r('no_face');
  }
  if (obs.faceCount > 1) {
    return r('multiple_faces');
  }
  const f = obs.primary;
  const ratio = videoWidth > 0 ? f.box.width / videoWidth : 0;
  if (ratio < GATES.minFaceRatio) {
    return r('too_far');
  }
  if (
    Math.abs(f.yawDeg) > GATES.maxYawDeg ||
    Math.abs(f.pitchDeg) > GATES.maxPitchDeg
  ) {
    return r('off_angle');
  }
  if (brightness < GATES.minBrightness) {
    return r('too_dark');
  }
  if (brightness > GATES.maxBrightness) {
    return r('too_bright');
  }
  return r('ok');
}
