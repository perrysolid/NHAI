import {computeComposite, confidenceFromCosine} from '../scoring';
import {SCORING, THRESHOLDS} from '../../config';

describe('composite scoring', () => {
  it('weights sum to 1', () => {
    const sum = Object.values(SCORING.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('confidence rises with cosine similarity', () => {
    expect(confidenceFromCosine(0.9)).toBeGreaterThan(
      confidenceFromCosine(0.5),
    );
    // Confidence crosses 0.5 exactly at the accept threshold (the boundary).
    expect(confidenceFromCosine(THRESHOLDS.recognitionCosine)).toBeCloseTo(
      0.5,
      1,
    );
  });

  it('scores an ideal capture near 100', () => {
    const r = computeComposite({
      recognitionConfidence: 1,
      livenessPassed: true,
      drowsy: false,
      lookingAway: false,
      ear: 0.9,
      yawDeg: 0,
      pitchDeg: 0,
      brightness: 145,
    });
    expect(r.overall).toBeGreaterThan(90);
    expect(r.lowTrust).toBe(false);
    const total = r.components.reduce((s, c) => s + c.contribution, 0);
    expect(Math.round(total)).toBe(r.overall);
  });

  it('drops to low-trust when liveness fails and subject is drowsy', () => {
    const r = computeComposite({
      recognitionConfidence: 0.6,
      livenessPassed: false,
      drowsy: true,
      lookingAway: true,
      ear: 0.1,
      yawDeg: 40,
      pitchDeg: 20,
      brightness: 30,
    });
    expect(r.overall).toBeLessThan(SCORING.reviewBelow);
    expect(r.lowTrust).toBe(true);
  });
});
