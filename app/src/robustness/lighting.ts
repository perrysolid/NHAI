import {THRESHOLDS} from '../config';

export interface LightingDecision {
  shouldUseTorch: boolean;
  shouldNormalize: boolean;
  guidance: string;
}

export function decideLighting(meanLuma: number): LightingDecision {
  if (meanLuma < THRESHOLDS.minBrightness) {
    return {
      shouldUseTorch: true,
      shouldNormalize: true,
      guidance: 'Too dark — enable torch or move to better light',
    };
  }
  if (meanLuma > THRESHOLDS.maxBrightness) {
    return {
      shouldUseTorch: false,
      shouldNormalize: true,
      guidance: 'Too bright — reduce glare',
    };
  }
  return {
    shouldUseTorch: false,
    shouldNormalize: false,
    guidance: 'Lighting ok',
  };
}

export function stretchLuma(
  input: Uint8Array,
  low = 5,
  high = 245,
): Uint8Array {
  if (input.length === 0) {
    return new Uint8Array();
  }
  let min = 255;
  let max = 0;
  for (const value of input) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (max <= min) {
    return new Uint8Array(input);
  }
  const out = new Uint8Array(input.length);
  const scale = (high - low) / (max - min);
  for (let i = 0; i < input.length; i++) {
    out[i] = Math.max(
      0,
      Math.min(255, Math.round((input[i] - min) * scale + low)),
    );
  }
  return out;
}
