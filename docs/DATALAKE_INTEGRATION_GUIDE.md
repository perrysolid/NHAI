# Datalake 3.0 Integration Guide

## Runtime Split

- Native app: camera capture, face quality gates, liveness, recognition,
  enrollment, verification, and queueing offline. The same React Native
  app/service pipeline is used for Android and iOS, so the integration is built
  to work well across both mobile platforms.
- Vercel web demo: deployable browser version for judges to test without an
  Android device.
- AWS/Render-compatible backend: receives already-verified attendance records
  and exposes `/admin`.

The backend is never part of the authentication decision.

## Native Auth Flow

1. Camera frame passes quality gates: one face, frontal pose, useful brightness.
2. Face crop is sent to `FaceEngine`.
3. Passive liveness score must pass `THRESHOLDS.livenessPassive`.
4. Active liveness must pass blink, smile, or head-turn challenges.
5. Recognition compares the probe embedding against encrypted local templates.
6. A verified record is added to the local queue.
7. When online, `syncPending()` posts the queue to the configured AWS/Render
   endpoint and purges records only after a successful response.

## Required Native Model Assets

The native app bundles both required assets — nothing further to add:

- `edgeface_s.tflite` — recognition, 14.2 MB float32, 112×112 → 512-d
- `minifasnet.tflite` — passive anti-spoof, 5.7 MB, 80×80 BGR

Total **19.9 MB**. `edgeface_s` is the active recognition model
(`ACTIVE_RECOGNITION` in `app/src/config.ts`). MobileFaceNet appears in config as
a spec placeholder only — its asset is not bundled and selecting it throws at
load.

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

The backend accepts this at `POST /api/sync` with `x-api-key`. The same Express
service can be hosted on AWS or Render; authentication never depends on it.

## Demo Checklist

1. Show airplane mode before enrollment.
2. Enroll one user with three clean captures.
3. Verify the same user locally.
4. Fail a spoof attempt by missing active liveness.
5. Re-enable network.
6. Sync queue to the configured AWS/Render endpoint.
7. Open `/admin?key=...` and show the record.
