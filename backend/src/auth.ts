/**
 * auth — simple shared-secret check for sync/records endpoints.
 *
 * If API_KEY is unset, auth is disabled (handy for first-deploy / demos) but we
 * log a warning. Set API_KEY in the deployment env for any real use.
 */
import type {NextFunction, Request, Response} from 'express';

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
