/**
 * secrets.example.ts — copy to `secrets.ts` (gitignored) and fill in real values.
 *
 *   cp src/secrets.example.ts src/secrets.ts
 *
 * Keeps the backend URL + shared key OUT of committed source. Note: any value
 * baked into a mobile binary is still extractable, so treat SYNC_API_KEY as a
 * low-trust device credential — the backend's server-side guard (rate limits,
 * timestamp/score checks) is what actually protects attendance integrity. The
 * production path is per-device tokens, not a shared key.
 */
export const SYNC_URL = 'https://YOUR-BACKEND/api/sync';
export const SYNC_API_KEY = 'CHANGE_ME';
