import {autoFireReady} from '../autoCapture';

const base = {
  now: 10_000,
  lastAt: 0,
  cooldownMs: 700,
  blocked: false,
  gateReady: true,
};

describe('autoFireReady (hands-free trigger)', () => {
  it('fires when the face is centered, idle, and the cooldown has elapsed', () => {
    expect(autoFireReady(base)).toBe(true);
  });

  it('never fires while the face is not centered (gate not ready)', () => {
    expect(autoFireReady({...base, gateReady: false})).toBe(false);
  });

  it('never fires while a capture/verify is in flight (blocked)', () => {
    expect(autoFireReady({...base, blocked: true})).toBe(false);
  });

  it('respects the cooldown window', () => {
    // 699ms since last trigger < 700ms cooldown.
    expect(autoFireReady({...base, now: 1_699, lastAt: 1_000})).toBe(false);
    // exactly at the cooldown boundary fires.
    expect(autoFireReady({...base, now: 1_700, lastAt: 1_000})).toBe(true);
  });

  it('uses the verify cooldown (3000ms) the same way', () => {
    expect(
      autoFireReady({...base, cooldownMs: 3_000, now: 4_000, lastAt: 1_500}),
    ).toBe(false); // 2500 < 3000
    expect(
      autoFireReady({...base, cooldownMs: 3_000, now: 4_500, lastAt: 1_500}),
    ).toBe(true); // 3000 >= 3000
  });

  it('blocked takes priority even when the cooldown has elapsed', () => {
    expect(
      autoFireReady({...base, blocked: true, now: 99_999, lastAt: 0}),
    ).toBe(false);
  });
});
