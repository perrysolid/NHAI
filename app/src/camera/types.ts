/**
 * Shared camera/face types.
 *
 * `Face` mirrors the subset of react-native-vision-camera-face-detector's output
 * we rely on. Angles are degrees; probabilities are 0..1. `bounds` is in frame
 * pixel coordinates.
 */
export interface FaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Face {
  bounds: FaceBounds;
  /** head rotation about vertical axis (left/right). */
  yawAngle: number;
  /** head rotation about horizontal axis (up/down). */
  pitchAngle: number;
  /** in-plane tilt. */
  rollAngle: number;
  /** classification probabilities (require classificationMode: 'all'). */
  smilingProbability?: number;
  leftEyeOpenProbability?: number;
  rightEyeOpenProbability?: number;
  /** stable id when trackingEnabled is on. */
  trackingId?: number;
}

/** Outcome of the quality gates. Exactly one face + good framing => 'ok'. */
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
  /** human guidance shown in the overlay. */
  guidance: string;
  /** true only when status === 'ok' (capture-ready). */
  ready: boolean;
}
