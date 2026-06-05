/**
 * syncClient — offline→online sync to the Render backend, then purge locally.
 *
 * The auth flow never depends on this; it runs only when the user triggers a
 * sync (or on reconnect). MOCK_SYNC simulates a 200 so the demo works with no
 * backend deployed.
 */
import {FLAGS, SYNC} from './config';
import {
  getQueue,
  purgeSynced,
  type AttendanceRecord,
} from './storage';

export interface SyncOutcome {
  ok: boolean;
  accepted: number;
  mocked: boolean;
  error?: string;
}

export async function syncPending(
  opts: {mock?: boolean} = {},
): Promise<SyncOutcome> {
  const mock = opts.mock ?? FLAGS.MOCK_SYNC;
  const pending = getQueue().filter(r => !r.synced);
  if (pending.length === 0) {
    return {ok: true, accepted: 0, mocked: mock};
  }

  if (mock) {
    purgeSynced(pending); // simulate a 200 then purge
    return {ok: true, accepted: pending.length, mocked: true};
  }

  try {
    const res = await fetch(`${SYNC.url}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': SYNC.apiKey,
      },
      body: JSON.stringify({records: pending}),
    });
    if (!res.ok) {
      return {
        ok: false,
        accepted: 0,
        mocked: false,
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {accepted?: number};
    purgeSynced(pending);
    return {
      ok: true,
      accepted: data.accepted ?? pending.length,
      mocked: false,
    };
  } catch (e) {
    return {
      ok: false,
      accepted: 0,
      mocked: false,
      error: e instanceof Error ? e.message : 'network error',
    };
  }
}

export type {AttendanceRecord};
