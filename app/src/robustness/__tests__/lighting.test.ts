import {decideLighting, stretchLuma} from '../lighting';

describe('lighting robustness', () => {
  it('requests torch and normalization in dark frames', () => {
    const decision = decideLighting(20);
    expect(decision.shouldUseTorch).toBe(true);
    expect(decision.shouldNormalize).toBe(true);
  });

  it('stretches luma contrast', () => {
    const out = stretchLuma(new Uint8Array([10, 20]));
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(245);
  });
});
