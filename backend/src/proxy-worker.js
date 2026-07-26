/**
 * Cloudflare Worker — lightweight proxy between the RN app and the Render
 * backend. Provides:
 *   1. Edge caching for GET /api/sites/for/:userId (cache in CF)
 *   2. Rate limiting per deviceId (Durable Object / KV counter)
 *   3. Request logging (Cloudflare Logpush)
 *   4. API key validation at the edge (rejects bad keys before they hit Render)
 *
 * Deploy:
 *   npx wrangler deploy backend/src/proxy-worker.js
 *   # Then set SYNC.url in config.ts to https://your-worker.workers.dev
 *
 * Environment secrets (wrangler secret put):
 *   BACKEND_ORIGIN  - https://datalake-face-sync.onrender.com
 *   API_KEY         - the shared secret (validates x-api-key at the edge)
 */

const BACKEND = (globalThis.BACKEND_ORIGIN ?? 'https://datalake-face-sync.onrender.com');
const EXPECTED_KEY = globalThis.API_KEY;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // ── Health check (pass through, no auth) ──
    if (path === '/health') {
      return fetch(`${BACKEND}${path}`);
    }

    // ── API key check at the edge ──
    const provided = request.headers.get('x-api-key');
    if (EXPECTED_KEY && provided !== EXPECTED_KEY) {
      return new Response(JSON.stringify({ok: false, error: 'invalid api key'}), {
        status: 401,
        headers: {'content-type': 'application/json'},
      });
    }

    // ── Rate limit per deviceId (on POST /api/sync) ──
    if (method === 'POST' && path === '/api/sync') {
      const deviceId = request.headers.get('x-device-id') ?? 'unknown';
      const rlKey = `rl:${deviceId}`;
      // Simple in-memory counter per worker instance (loses count on cold start
      // but good enough for burst protection). For production, use a Durable
      // Object or KV with TTL.
      const COUNTERS = globalThis.__rl || (globalThis.__rl = new Map());
      const now = Date.now();
      const windowMs = 60_000;
      const maxReqs = 30;
      let entry = COUNTERS.get(rlKey);
      if (!entry || now - entry.reset > windowMs) {
        entry = {count: 0, reset: now};
        COUNTERS.set(rlKey, entry);
      }
      entry.count++;
      if (entry.count > maxReqs) {
        return new Response(JSON.stringify({ok: false, error: 'rate limited'}), {
          status: 429,
          headers: {'content-type': 'application/json', 'retry-after': '60'},
        });
      }
    }

    // ── Cache GET /api/sites/for/:userId (TTL 300s) ──
    if (method === 'GET' && path.startsWith('/api/sites/for/')) {
      const cacheKey = new Request(`${BACKEND}${path}`, request);
      const cache = caches.default;
      let response = await cache.match(cacheKey);
      if (!response) {
        response = await fetch(cacheKey);
        if (response.ok) {
          const cloned = new Response(response.body, response);
          cloned.headers.set('cache-control', 'public, max-age=300');
          // Must wait for cache.put in background to avoid blocking the response
          ctx.waitUntil(cache.put(cacheKey, cloned));
        }
      }
      return response;
    }

    // ── Everything else: pass through to backend ──
    return fetch(`${BACKEND}${path}`, {
      method,
      headers: request.headers,
      body: method !== 'GET' && method !== 'HEAD' ? request.body : undefined,
    });
  },
};
