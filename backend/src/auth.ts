/**
 * auth — device API key guard + admin token management.
 *
 * Device endpoints check x-api-key against API_KEY (env).
 * Admin endpoints check x-api-key against an in-memory token set issued
 * on login. The two secrets are independent so the API key baked into
 * the app binary does not grant admin access.
 *
 * FAIL CLOSED. These guards used to wave every request through when their env
 * vars were unset, which meant a deploy that forgot ADMIN_USER/ADMIN_PASSWORD
 * served the entire attendance registry — names, timings, GPS traces — to
 * anyone who found the URL, with no error anywhere to reveal it. Missing
 * credentials now refuse the request, and the process refuses to start at all
 * (see assertAuthConfigured) so the failure is loud and immediate rather than
 * silent and permanent.
 *
 * Local demos that genuinely want no auth must opt in explicitly with
 * ALLOW_INSECURE_NO_AUTH=1. Never set that on a deployed instance.
 */
import crypto from 'crypto';
import type {NextFunction, Request, Response} from 'express';

const adminTokens = new Set<string>();

/** Explicit, deliberate opt-out of authentication — local development only. */
export function insecureAuthAllowed(): boolean {
  const v = process.env.ALLOW_INSECURE_NO_AUTH;
  return v === '1' || v === 'true';
}

/** Names of the credentials that are required but absent. */
export function missingAuthConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.API_KEY) {
    missing.push('API_KEY');
  }
  if (!process.env.ADMIN_USER) {
    missing.push('ADMIN_USER');
  }
  if (!process.env.ADMIN_PASSWORD) {
    missing.push('ADMIN_PASSWORD');
  }
  return missing;
}

/**
 * Throw unless the service is safe to expose. Called before listen() so a
 * misconfigured deploy dies on startup instead of quietly serving unprotected
 * biometric attendance data.
 */
export function assertAuthConfigured(): void {
  const missing = missingAuthConfig();
  if (missing.length === 0 || insecureAuthAllowed()) {
    return;
  }
  throw new Error(
    `refusing to start: missing ${missing.join(', ')}. ` +
      'Set them, or set ALLOW_INSECURE_NO_AUTH=1 to run without authentication ' +
      '(local development only — never on a deployed instance).',
  );
}

/** Generate and store a unique admin session token. */
export function generateAdminToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  return token;
}

/** Discard an admin session token (logout). */
export function revokeAdminToken(token: string): void {
  adminTokens.delete(token);
}

/** 503 rather than 401: the client did nothing wrong, the server is unsafe. */
function unconfigured(res: Response): void {
  res.status(503).json({
    ok: false,
    error: 'server authentication is not configured',
  });
}

/**
 * Guard for device-facing endpoints (sync, enroll, device-pull).
 * Checks x-api-key against the shared API_KEY env var.
 */
export function apiKeyGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.API_KEY;
  if (!expected) {
    if (insecureAuthAllowed()) {
      next();
      return;
    }
    unconfigured(res);
    return;
  }
  const provided = req.header('x-api-key');
  if (provided !== expected) {
    res.status(401).json({ok: false, error: 'invalid api key'});
    return;
  }
  next();
}

/**
 * Guard for admin-only endpoints (sites CRUD, enrollment list/delete, records).
 * Checks x-api-key against the in-memory admin token set, issued on login.
 */
export function adminGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    if (insecureAuthAllowed()) {
      next();
      return;
    }
    unconfigured(res);
    return;
  }
  const token = req.header('x-api-key');
  if (!token || !adminTokens.has(token)) {
    res.status(401).json({ok: false, error: 'invalid admin token'});
    return;
  }
  next();
}

/**
 * Guard for the server-rendered ops console at /admin?key=…, which uses its own
 * passcode rather than a login token.
 */
export function adminPasscodeOk(key: unknown): boolean {
  const passcode = process.env.ADMIN_PASSCODE;
  if (!passcode) {
    return insecureAuthAllowed();
  }
  return key === passcode;
}
