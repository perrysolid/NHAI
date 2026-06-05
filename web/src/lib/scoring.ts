/**
 * scoring — composite Authentication Score.
 *
 * Each signal is normalized to a 0..1 sub-score, multiplied by its configured
 * weight, and summed to a single 0..100 score. The breakdown (per-component
 * sub-score, weight and contribution) is returned so the decision is fully
 * transparent and tunable. Pure & deterministic.
 */
import {SCORING, GATES, DROWSINESS} from './config';

export interface ScoreInput {
  /** recognition confidence from match distance (0..1). */
  recognitionConfidence: number;
  livenessPassed: boolean;
  drowsy: boolean;
  lookingAway: boolean;
  ear: number;
  yawDeg: number;
  pitchDeg: number;
  brightness: number;
}

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  /** sub-score 0..1. */
  score: number;
  /** weight * score * 100 — points contributed to the overall. */
  contribution: number;
}

export interface CompositeScore {
  /** 0..100. */
  overall: number;
  lowTrust: boolean;
  components: ScoreComponent[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function poseScore(yawDeg: number, pitchDeg: number): number {
  const y = clamp01(1 - Math.abs(yawDeg) / (GATES.maxYawDeg * 1.5));
  const p = clamp01(1 - Math.abs(pitchDeg) / (GATES.maxPitchDeg * 1.5));
  return (y + p) / 2;
}

function illuminationScore(brightness: number): number {
  const ideal = (GATES.minBrightness + GATES.maxBrightness) / 2;
  const spread = (GATES.maxBrightness - GATES.minBrightness) / 1.4;
  return clamp01(1 - Math.abs(brightness - ideal) / spread);
}

function alertnessScore(
  drowsy: boolean,
  lookingAway: boolean,
  ear: number,
): number {
  let s = clamp01(ear / (DROWSINESS.earClosed * 1.5)); // 1 when eyes well open
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
    ['recognition', 'Recognition', w.recognition, clamp01(input.recognitionConfidence)],
    ['liveness', 'Liveness', w.liveness, input.livenessPassed ? 1 : 0],
    ['alertness', 'Alertness', w.alertness, alertnessScore(input.drowsy, input.lookingAway, input.ear)],
    ['pose', 'Pose', w.pose, poseScore(input.yawDeg, input.pitchDeg)],
    ['illumination', 'Lighting', w.illumination, illuminationScore(input.brightness)],
  ];
  const components: ScoreComponent[] = subs.map(([key, label, weight, score]) => ({
    key,
    label,
    weight,
    score,
    contribution: weight * score * 100,
  }));
  const overall = components.reduce((s, c) => s + c.contribution, 0);
  return {
    overall: Math.round(overall),
    lowTrust: overall < SCORING.reviewBelow,
    components,
  };
}
