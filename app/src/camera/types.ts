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

export interface Point {
  x: number;
  y: number;
}

/** Raw ML Kit landmark subset — the UPPER_SNAKE keys the detector emits when
 *  landmarkMode: 'all'. Coordinates are in frame pixels. */
export interface RawLandmarks {
  LEFT_EYE: Point;
  RIGHT_EYE: Point;
  NOSE_BASE: Point;
  MOUTH_LEFT: Point;
  MOUTH_RIGHT: Point;
}

/** The 5 ArcFace landmarks in semantic form, used to similarity-align the crop. */
export interface FaceLandmarks {
  leftEye: Point;
  rightEye: Point;
  noseBase: Point;
  mouthLeft: Point;
  mouthRight: Point;
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
  /** Present only when the detector runs with landmarkMode: 'all'. */
  landmarks?: RawLandmarks;
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
