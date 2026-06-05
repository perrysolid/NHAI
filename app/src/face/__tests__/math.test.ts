import {
  averageEmbeddings,
  cosineSimilarity,
  l2Normalize,
  matchEmbedding,
} from '../math';

describe('face math', () => {
  it('normalizes vectors', () => {
    const out = l2Normalize([3, 4]);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.8);
  });

  it('averages embeddings and normalizes the template', () => {
    const out = averageEmbeddings([
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
    ]);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(0);
  });

  it('matches by cosine threshold', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(matchEmbedding([1, 0], [1, 0], 0.9).matched).toBe(true);
    expect(matchEmbedding([1, 0], [0, 1], 0.9).matched).toBe(false);
  });
});
