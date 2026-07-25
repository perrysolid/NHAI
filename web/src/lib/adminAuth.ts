/**
 * adminAuth — minimal session for the admin dashboard. Posts username/password
 * to the backend (Render), stores the returned token in sessionStorage, and
 * hands it back as the x-api-key for admin API calls. Swap the backend check for
 * Supabase auth later without changing this client contract.
 */
import {SYNC} from './config';

const TOKEN_KEY = 'dfa.admin.token';

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function isAuthed(): boolean {
  return getToken().length > 0;
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function login(
  username: string,
  password: string,
): Promise<{ok: boolean; error?: string}> {
  try {
    const res = await fetch(`${SYNC.url}/api/admin/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username, password}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      token?: string;
      error?: string;
    };
    if (res.ok && data.ok && typeof data.token === 'string') {
      sessionStorage.setItem(TOKEN_KEY, data.token);
      return {ok: true};
    }
    return {ok: false, error: data.error ?? `login failed (HTTP ${res.status})`};
  } catch {
    return {
      ok: false,
      error: 'Could not reach the admin backend. Check the Render URL / network.',
    };
  }
}
