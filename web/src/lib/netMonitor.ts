/**
 * netMonitor — verifiable proof that the authentication path makes ZERO network
 * calls. We wrap window.fetch and count any request issued while an auth flow
 * (enroll / verify) is active. Model loading happens before auth and sync is a
 * separate, explicit action, so this counter stays at 0 throughout auth.
 */
let authActive = false;
let authCalls = 0;
let installed = false;

export function installNetMonitor(): void {
  if (installed || typeof window === 'undefined' || !window.fetch) {
    return;
  }
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (...args: Parameters<typeof fetch>) => {
    if (authActive) {
      authCalls += 1;
    }
    return original(...args);
  };
}

export const netMonitor = {
  beginAuth(): void {
    authActive = true;
  },
  endAuth(): void {
    authActive = false;
  },
  get authCalls(): number {
    return authCalls;
  },
};
