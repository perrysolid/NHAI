/**
 * Store integrity tests.
 *
 * These cover the checks that decide whether an attendance record is kept,
 * rejected, or refused for backpressure. Every case below corresponds to a bug
 * that actually shipped, so they are regression tests first and documentation
 * second. MemoryStore is exercised directly — it implements the same guard
 * semantics as the Postgres and Supabase backends.
 */
import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimitExceededError,
  createStore,
  sanitizeMany,
  type AttendanceRecord,
  type Store,
} from './store.js';

function rec(over: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    userId: 'u1',
    timestamp: 1_000,
    deviceId: 'd1',
    livenessPassed: true,
    matchDistance: 0.2,
    ...over,
  };
}

/** guard() then add(), the exact order the /api/sync route uses. */
async function submit(store: Store, records: AttendanceRecord[]) {
  const guarded = await store.guard(records);
  return guarded.length ? store.add(guarded) : [];
}

let store: Store;
beforeEach(() => {
  delete process.env.DATABASE_URL;
  store = createStore();
});

describe('score sanity', () => {
  test('accepts a well-formed record', async () => {
    assert.equal((await submit(store, [rec()])).length, 1);
  });

  test('rejects matchDistance above 1', async () => {
    // The old client computed 1 - cosine; impostors score negative cosine, so
    // this is what a failed verify used to send.
    assert.equal((await store.guard([rec({matchDistance: 1.2})])).length, 0);
  });

  test('rejects negative matchDistance', async () => {
    assert.equal((await store.guard([rec({matchDistance: -0.1})])).length, 0);
  });

  test('rejects out-of-range score and confidence', async () => {
    assert.equal((await store.guard([rec({score: 9999})])).length, 0);
    assert.equal((await store.guard([rec({confidence: 5})])).length, 0);
  });

  test('rejects negative latency', async () => {
    assert.equal((await store.guard([rec({latencyMs: -1})])).length, 0);
  });
});

describe('replay and idempotency', () => {
  test('rejects a strictly older record for the same device', async () => {
    await submit(store, [rec({timestamp: 5_000})]);
    assert.equal((await store.guard([rec({timestamp: 4_000})])).length, 0);
  });

  test('re-acknowledges an identical re-send so the device can purge it', async () => {
    // Regression: a lost response made the device resubmit; the server rejected
    // the retry as non-monotonic and the device could never purge what the
    // server would not acknowledge, wedging that record forever.
    const r = rec({timestamp: 5_000});
    assert.equal((await submit(store, [r])).length, 1);
    const retry = await submit(store, [r]);
    assert.equal(retry.length, 1, 'retry must be acknowledged');
  });

  test('a re-send is stored only once', async () => {
    const r = rec({timestamp: 5_000});
    await submit(store, [r]);
    await submit(store, [r]);
    const rows = await store.list(100);
    assert.equal(rows.filter(x => x.timestamp === 5_000).length, 1);
  });

  test('rejects a record backdated behind another device for the same user', async () => {
    await submit(store, [rec({deviceId: 'dA', timestamp: 9_000})]);
    const injected = await store.guard([
      rec({deviceId: 'dB', timestamp: 8_000}),
    ]);
    assert.equal(injected.length, 0);
  });
});

describe('rate limiting', () => {
  test('allows a device up to its budget', async () => {
    for (let i = 1; i <= 30; i++) {
      const out = await submit(store, [
        rec({deviceId: 'burst', timestamp: 1_000 + i}),
      ]);
      assert.equal(out.length, 1, `record ${i} should be accepted`);
    }
  });

  test('signals backpressure instead of discarding data', async () => {
    // Over-budget records used to be dropped inside guard(). Because the device
    // only purges what the server acknowledges, that permanently destroyed
    // genuine attendance from any device returning from an outage — the normal
    // case for an offline-first system.
    for (let i = 1; i <= 30; i++) {
      await submit(store, [rec({deviceId: 'burst', timestamp: 1_000 + i})]);
    }
    await assert.rejects(
      () => store.guard([rec({deviceId: 'burst', timestamp: 2_000})]),
      RateLimitExceededError,
    );
  });

  test('backdated timestamps do not bypass the limiter', async () => {
    // The window was once derived from the device-supplied ts field, so sending
    // 1970-era timestamps skipped the limit entirely. It is now counted on the
    // server clock.
    for (let i = 1; i <= 30; i++) {
      await submit(store, [rec({deviceId: 'sneaky', timestamp: 100 + i})]);
    }
    await assert.rejects(
      () => store.guard([rec({deviceId: 'sneaky', timestamp: 131})]),
      RateLimitExceededError,
    );
  });

  test('budgets are per device', async () => {
    // Separate userIds on purpose: sharing one would trip the cross-device
    // timeline check instead, and this test would pass for the wrong reason.
    for (let i = 1; i <= 30; i++) {
      await submit(store, [
        rec({userId: 'loudUser', deviceId: 'loud', timestamp: 1_000 + i}),
      ]);
    }
    const quiet = await submit(store, [
      rec({userId: 'quietUser', deviceId: 'quiet', timestamp: 1_000}),
    ]);
    assert.equal(quiet.length, 1, 'a quiet device must be unaffected');
  });
});

describe('sanitizeMany', () => {
  test('drops entries missing required identity fields', () => {
    const out = sanitizeMany([
      {userId: 'u1', deviceId: 'd1', timestamp: 1},
      {userId: 'u1', timestamp: 1}, // no deviceId
      {deviceId: 'd1', timestamp: 1}, // no userId
      {userId: 'u1', deviceId: 'd1', timestamp: 'nope'}, // unparseable
      null,
      'string',
    ]);
    assert.equal(out.length, 1);
  });

  test('is not an array in, not an array out', () => {
    assert.deepEqual(sanitizeMany(undefined), []);
    assert.deepEqual(sanitizeMany({}), []);
  });

  test('truncates over-long identifiers', () => {
    const out = sanitizeMany([
      {userId: 'u'.repeat(500), deviceId: 'd'.repeat(500), timestamp: 1},
    ]);
    assert.equal(out[0].userId.length, 128);
    assert.equal(out[0].deviceId.length, 128);
  });

  test('lifts a flat location payload into a nested object', () => {
    const out = sanitizeMany([
      {
        userId: 'u1',
        deviceId: 'd1',
        timestamp: 1,
        lat: 28.6,
        lon: 77.2,
        accuracyM: 12,
        geofencePassed: true,
      },
    ]);
    assert.equal(out[0].location?.lat, 28.6);
    assert.equal(out[0].location?.geofencePassed, true);
  });

  test('omits location entirely when there is no fix', () => {
    const out = sanitizeMany([{userId: 'u1', deviceId: 'd1', timestamp: 1}]);
    assert.equal(out[0].location, undefined);
  });
});

describe('list', () => {
  test('returns newest first and honours the limit', async () => {
    for (const ts of [1_000, 3_000, 2_000]) {
      await submit(store, [rec({timestamp: ts, deviceId: `d${ts}`})]);
    }
    const rows = await store.list(2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].timestamp, 3_000);
  });

  test('filters by since', async () => {
    for (const ts of [1_000, 3_000]) {
      await submit(store, [rec({timestamp: ts, deviceId: `d${ts}`})]);
    }
    assert.equal((await store.list(100, 2_000)).length, 1);
  });
});
