/**
 * autoCapture — the pure decision that drives hands-free operation.
 *
 * Both the enrollment auto-capture loop and the verification auto-start loop
 * ask the same question every tick: given that the face is centered (gateReady)
 * and nothing is in flight (blocked), has enough time passed since the last
 * trigger to fire again? Extracted here so the exact shipped gating logic is
 * deterministically unit-testable, independent of the camera/React stack.
 */
export interface AutoFireInput {
  /** current time (ms). */
  now: number;
  /** timestamp of the previous trigger (ms); 0 if never. */
  lastAt: number;
  /** minimum spacing between triggers (ms). */
  cooldownMs: number;
  /** true while a capture/verify is in flight (busy) or a challenge is running. */
  blocked: boolean;
  /** true only when the quality gate reports the face is centered & framed. */
  gateReady: boolean;
}

export function autoFireReady(input: AutoFireInput): boolean {
  if (input.blocked || !input.gateReady) {
    return false;
  }
  return input.now - input.lastAt >= input.cooldownMs;
}
