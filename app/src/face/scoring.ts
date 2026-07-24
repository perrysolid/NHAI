/**
 * scoring — composite Authentication Score (0..100), a weighted aggregate of
 * recognition, liveness, alertness, pose and lighting. Pure & deterministic.
 * Mirrors the web demo so both surfaces score identically.
 */
import {SCORING, THRESHOLDS} from '../config';

export interface ScoreInput {
  /** recognition confidence 0..1 (from cosine similarity vs the threshold). */
  recognitionConfidence: number;
  livenessPassed: boolean;
  drowsy: boolean;
  lookingAway: boolean;
  /** eye-open proxy 0..1. */
  ear: number;
  yawDeg: number;
  pitchDeg: number;
  brightness: number;
}

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  score: number;
  contribution: number;
}

export interface CompositeScore {
  overall: number;
  lowTrust: boolean;
  components: ScoreComponent[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Map cosine similarity to a 0..1 confidence centred on the match threshold. */
export function confidenceFromCosine(cosine: number): number {
  const steepness = SCORING.confidenceSteepness;
  return (
    1 / (1 + Math.exp(-steepness * (cosine - THRESHOLDS.recognitionCosine)))
  );
}

function poseScore(yawDeg: number, pitchDeg: number): number {
  const y = clamp01(1 - Math.abs(yawDeg) / (THRESHOLDS.maxYawDeg * 1.5));
  const p = clamp01(1 - Math.abs(pitchDeg) / (THRESHOLDS.maxPitchDeg * 1.5));
  return (y + p) / 2;
}

function illuminationScore(brightness: number): number {
  const ideal = (THRESHOLDS.minBrightness + THRESHOLDS.maxBrightness) / 2;
  const spread = (THRESHOLDS.maxBrightness - THRESHOLDS.minBrightness) / 1.4;
  return clamp01(1 - Math.abs(brightness - ideal) / spread);
}

function alertnessScore(
  drowsy: boolean,
  lookingAway: boolean,
  ear: number,
): number {
  let s = clamp01(ear / 0.6);
  if (drowsy) {
    s *= 0.4;
  }
  if (lookingAway) {
    s *= 0.7;
  }
  return clamp01(s);
}

export function computeComposite(input: ScoreInput): CompositeScore {
  const w = SCORING.weights;
  const subs: Array<[string, string, number, number]> = [
    [
      'recognition',
      'Recognition',
      w.recognition,
      clamp01(input.recognitionConfidence),
    ],
    ['liveness', 'Liveness', w.liveness, input.livenessPassed ? 1 : 0],
    [
      'alertness',
      'Alertness',
      w.alertness,
      alertnessScore(input.drowsy, input.lookingAway, input.ear),
    ],
    ['pose', 'Pose', w.pose, poseScore(input.yawDeg, input.pitchDeg)],
    [
      'illumination',
      'Lighting',
      w.illumination,
      illuminationScore(input.brightness),
    ],
  ];
  const components: ScoreComponent[] = subs.map(
    ([key, label, weight, score]) => ({
      key,
      label,
      weight,
      score,
      contribution: weight * score * 100,
    }),
  );
  const overall = components.reduce((s, c) => s + c.contribution, 0);
  return {
    overall: Math.round(overall),
    lowTrust: overall < SCORING.reviewBelow,
    components,
  };
}
