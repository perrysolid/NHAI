import {summarizeBenchmark} from '../benchmark';

describe('benchmark summary', () => {
  it('tracks total latency target', () => {
    expect(
      summarizeBenchmark([
        {name: 'detect', ms: 100},
        {name: 'recognize', ms: 200},
      ]).passedLatencyTarget,
    ).toBe(true);
    expect(
      summarizeBenchmark([{name: 'slow', ms: 1200}]).passedLatencyTarget,
    ).toBe(false);
  });
});
