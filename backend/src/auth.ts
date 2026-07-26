/**
 * auth — device API key guard + admin token management.
 *
 * Device endpoints check x-api-key against API_KEY (env).
 * Admin endpoints check x-api-key against an in-memory token set issued
 * on login. The two secrets are independent so the API key baked into
 * the app binary does not grant admin access.
 *
 * When API_KEY (or ADMIN_USER/ADMIN_PASSWORD) is unset the corresponding
 * guard is disabled — handy for first-deploy / demos.
 */
import crypto from 'crypto';
import type {NextFunction, Request, Response} from 'express';

const adminTokens = new Set<string>();

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
    next();
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
 * When no admin credentials are configured, auth is disabled for dev/demo.
 */
export function adminGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    next();
    return;
  }
  const token = req.header('x-api-key');
  if (!token || !adminTokens.has(token)) {
    res.status(401).json({ok: false, error: 'invalid admin token'});
    return;
  }
  next();
}
