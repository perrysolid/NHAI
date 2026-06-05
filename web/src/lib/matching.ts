/**
 * matching — descriptor math for recognition. Pure & unit-testable.
 *
 * face-api descriptors are 128-d Float32Array. We match by Euclidean distance
 * (face-api's native metric); cosine is provided too for parity with the native
 * EdgeFace pipeline.
 */
import {RECOGNITION} from './config';

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`descriptor length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Average several descriptors into one enrollment template. */
export function averageDescriptors(list: Float32Array[]): Float32Array {
  if (list.length === 0) {
    throw new Error('no descriptors to average');
  }
  const len = list[0].length;
  const out = new Float32Array(len);
  for (const d of list) {
    for (let i = 0; i < len; i++) {
      out[i] += d[i];
    }
  }
  for (let i = 0; i < len; i++) {
    out[i] /= list.length;
  }
  return out;
}

export interface MatchResult {
  distance: number;
  similarity: number;
  isMatch: boolean;
}

export function matchDescriptor(
  probe: Float32Array,
  template: Float32Array,
): MatchResult {
  const distance = euclideanDistance(probe, template);
  return {
    distance,
    similarity: cosineSimilarity(probe, template),
    isMatch: distance < RECOGNITION.matchDistance,
  };
}
