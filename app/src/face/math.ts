import {THRESHOLDS} from '../config';

export type Embedding = Float32Array;

export interface MatchResult {
  matched: boolean;
  cosine: number;
}

export function l2Normalize(values: ArrayLike<number>): Embedding {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * values[i];
  }
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i] / norm;
  }
  return out;
}

export function averageEmbeddings(samples: ArrayLike<number>[]): Embedding {
  if (samples.length === 0) {
    throw new Error('at least one embedding is required');
  }
  const length = samples[0].length;
  const out = new Float32Array(length);
  for (const sample of samples) {
    if (sample.length !== length) {
      throw new Error('embedding lengths must match');
    }
    for (let i = 0; i < length; i++) {
      out[i] += sample[i];
    }
  }
  for (let i = 0; i < length; i++) {
    out[i] /= samples.length;
  }
  return l2Normalize(out);
}

export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  if (a.length !== b.length) {
    throw new Error('embedding lengths must match');
  }
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  const denom = Math.sqrt(an) * Math.sqrt(bn);
  return denom === 0 ? 0 : dot / denom;
}

export function matchEmbedding(
  probe: ArrayLike<number>,
  enrolled: ArrayLike<number>,
  threshold = THRESHOLDS.recognitionCosine,
): MatchResult {
  const cosine = cosineSimilarity(probe, enrolled);
  return {cosine, matched: cosine >= threshold};
}
