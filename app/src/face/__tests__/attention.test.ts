import {AttentionMonitor, type AttentionSnapshot} from '../attention';

function feed(
  m: AttentionMonitor,
  eyeOpen: number,
  from: number,
  to: number,
): AttentionSnapshot {
  let last: AttentionSnapshot = m.snapshot(from);
  for (let t = from; t <= to; t += 100) {
    last = m.update({eyeOpen, yawDeg: 0, present: true}, t);
  }
  return last;
}

describe('AttentionMonitor', () => {
  it('reports alert when eyes are open', () => {
    const m = new AttentionMonitor();
    const s = feed(m, 0.9, 0, 2000);
    expect(s.state).toBe('alert');
    expect(s.drowsy).toBe(false);
    expect(s.perclos).toBeLessThan(0.1);
  });

  it('flags drowsy on a sustained eye closure (micro-sleep)', () => {
    const m = new AttentionMonitor();
    feed(m, 0.9, 0, 1000);
    const s = feed(m, 0.05, 1100, 3000); // ~1.9s closed
    expect(s.drowsy).toBe(true);
    expect(s.state).toBe('drowsy');
    expect(s.longestClosureMs).toBeGreaterThanOrEqual(1100);
  });

  it('flags looking away on head yaw', () => {
    const m = new AttentionMonitor();
    const s = m.update({eyeOpen: 0.9, yawDeg: 40, present: true}, 100);
    expect(s.lookingAway).toBe(true);
  });

  it('returns no-face when nobody is present', () => {
    const m = new AttentionMonitor();
    const s = m.update({eyeOpen: 0, yawDeg: 0, present: false}, 100);
    expect(s.state).toBe('no-face');
  });
});
