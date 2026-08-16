/**
 * Auth guard tests.
 *
 * The guards used to wave every request through when their env vars were unset,
 * so a deploy that forgot ADMIN_USER/ADMIN_PASSWORD served the whole attendance
 * registry to anyone with the URL and nothing anywhere reported it. These tests
 * pin the fail-closed behaviour and the single explicit escape hatch.
 */
import {test, describe, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import type {NextFunction, Request, Response} from 'express';
import {
  adminGuard,
  adminPasscodeOk,
  apiKeyGuard,
  assertAuthConfigured,
  generateAdminToken,
  insecureAuthAllowed,
  missingAuthConfig,
  revokeAdminToken,
} from './auth.js';

const AUTH_VARS = [
  'API_KEY',
  'ADMIN_USER',
  'ADMIN_PASSWORD',
  'ADMIN_PASSCODE',
  'ALLOW_INSECURE_NO_AUTH',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of AUTH_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of AUTH_VARS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

/** Minimal express doubles: capture the status/body a guard produces. */
function run(
  guard: (req: Request, res: Response, next: NextFunction) => void,
  headers: Record<string, string> = {},
): {status: number; passed: boolean} {
  let status = 200;
  let passed = false;
  const req = {
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  guard(req, res, () => {
    passed = true;
  });
  return {status, passed};
}

describe('startup configuration', () => {
  test('refuses to start when credentials are missing', () => {
    assert.throws(() => assertAuthConfigured(), /refusing to start/);
  });

  test('names every missing credential so the fix is obvious', () => {
    assert.deepEqual(missingAuthConfig(), [
      'API_KEY',
      'ADMIN_USER',
      'ADMIN_PASSWORD',
    ]);
  });

  test('starts once everything is configured', () => {
    process.env.API_KEY = 'k';
    process.env.ADMIN_USER = 'u';
    process.env.ADMIN_PASSWORD = 'p';
    assert.deepEqual(missingAuthConfig(), []);
    assert.doesNotThrow(() => assertAuthConfigured());
  });

  test('starts unprotected only via the explicit opt-in', () => {
    process.env.ALLOW_INSECURE_NO_AUTH = '1';
    assert.equal(insecureAuthAllowed(), true);
    assert.doesNotThrow(() => assertAuthConfigured());
  });

  test('the opt-in is not triggered by stray values', () => {
    for (const v of ['0', 'false', '', 'yes please', 'TRUE ']) {
      process.env.ALLOW_INSECURE_NO_AUTH = v;
      assert.equal(insecureAuthAllowed(), false, `"${v}" must not disable auth`);
    }
  });
});

describe('apiKeyGuard', () => {
  test('refuses the request when API_KEY is unset', () => {
    const out = run(apiKeyGuard);
    assert.equal(out.passed, false);
    assert.equal(out.status, 503);
  });

  test('rejects a wrong key', () => {
    process.env.API_KEY = 'right';
    const out = run(apiKeyGuard, {'x-api-key': 'wrong'});
    assert.equal(out.passed, false);
    assert.equal(out.status, 401);
  });

  test('rejects a missing key', () => {
    process.env.API_KEY = 'right';
    assert.equal(run(apiKeyGuard).passed, false);
  });

  test('accepts the correct key', () => {
    process.env.API_KEY = 'right';
    assert.equal(run(apiKeyGuard, {'x-api-key': 'right'}).passed, true);
  });

  test('passes through only under the explicit opt-in', () => {
    process.env.ALLOW_INSECURE_NO_AUTH = '1';
    assert.equal(run(apiKeyGuard).passed, true);
  });
});

describe('adminGuard', () => {
  test('refuses the request when admin credentials are unset', () => {
    const out = run(adminGuard);
    assert.equal(out.passed, false);
    assert.equal(out.status, 503);
  });

  test('rejects a request with no token', () => {
    process.env.ADMIN_USER = 'u';
    process.env.ADMIN_PASSWORD = 'p';
    const out = run(adminGuard);
    assert.equal(out.passed, false);
    assert.equal(out.status, 401);
  });

  test('the device API key does not grant admin access', () => {
    // The key baked into the app binary is extractable; it must never be an
    // admin credential.
    process.env.API_KEY = 'device-key';
    process.env.ADMIN_USER = 'u';
    process.env.ADMIN_PASSWORD = 'p';
    const out = run(adminGuard, {'x-api-key': 'device-key'});
    assert.equal(out.passed, false);
    assert.equal(out.status, 401);
  });

  test('accepts an issued session token, and rejects it after revocation', () => {
    process.env.ADMIN_USER = 'u';
    process.env.ADMIN_PASSWORD = 'p';
    const token = generateAdminToken();
    assert.equal(run(adminGuard, {'x-api-key': token}).passed, true);
    revokeAdminToken(token);
    assert.equal(run(adminGuard, {'x-api-key': token}).passed, false);
  });

  test('issues unpredictable tokens', () => {
    const a = generateAdminToken();
    const b = generateAdminToken();
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    revokeAdminToken(a);
    revokeAdminToken(b);
  });
});

describe('adminPasscodeOk (/admin console)', () => {
  test('denies when no passcode is configured', () => {
    assert.equal(adminPasscodeOk(undefined), false);
    assert.equal(adminPasscodeOk('anything'), false);
  });

  test('allows an unprotected console only under the explicit opt-in', () => {
    process.env.ALLOW_INSECURE_NO_AUTH = '1';
    assert.equal(adminPasscodeOk(undefined), true);
  });

  test('matches the configured passcode exactly', () => {
    process.env.ADMIN_PASSCODE = 's3cret';
    assert.equal(adminPasscodeOk('s3cret'), true);
    assert.equal(adminPasscodeOk('S3CRET'), false);
    assert.equal(adminPasscodeOk(undefined), false);
    assert.equal(adminPasscodeOk(['s3cret']), false);
  });
});
