# Datalake 3.0 Integration Guide

## Runtime Split

- Native app: camera capture, face quality gates, liveness, recognition,
  enrollment, verification, and queueing offline.
- Vercel web demo: deployable browser version for judges to test without an
  Android device.
- Render backend: receives already-verified attendance records and exposes
  `/admin`.

The backend is never part of the authentication decision.

## Native Auth Flow

1. Camera frame passes quality gates: one face, frontal pose, useful brightness.
2. Face crop is sent to `FaceEngine`.
3. Passive liveness score must pass `THRESHOLDS.livenessPassive`.
4. Active liveness must pass blink, smile, or head-turn challenges.
5. Recognition compares the probe embedding against encrypted local templates.
6. A verified record is added to the local queue.
7. When online, `syncPending()` posts the queue to Render and purges records only
   after a successful response.

## Required Native Model Assets

The runnable native demo already includes:

- `mobilefacenet.tflite`
- `minifasnet.tflite`

For the compact production target, add:

- `edgeface_s.tflite`
- `mobilefacenet.tflite` optional fallback

Before demoing production inference, open each file in Netron and confirm the
I/O in `app/src/config.ts`.

## Render Payload

The native sync client sends:

```json
{
  "records": [
    {
      "userId": "inspector_01",
      "timestamp": 1780655230110,
      "livenessPassed": true,
      "livenessScore": 0.91,
      "matchScore": 0.74,
      "matchDistance": 0.74,
      "deviceId": "rn-device"
    }
  ]
}
```

Render accepts this at `POST /api/sync` with `x-api-key`.

## Demo Checklist

1. Show airplane mode before enrollment.
2. Enroll one user with three clean captures.
3. Verify the same user locally.
4. Fail a spoof attempt by missing active liveness.
5. Re-enable network.
6. Sync queue to Render.
7. Open `/admin?key=...` and show the record.
