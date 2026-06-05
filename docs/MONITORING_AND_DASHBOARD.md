# Frame Inspection, Drowsiness Detection & Operations Console

All inspection metrics are derived **on-device** from the same 68-point facial
landmarks already used for liveness — no extra model, no network. Only the
resulting summary is attached to a verified attendance record and synced.

## How drowsiness and attention are detected

| Signal | Method | Drowsy / flag condition |
|--------|--------|--------------------------|
| **EAR** (Eye Aspect Ratio) | ratio of vertical to horizontal eye-landmark distances per frame; high when open (~0.30), low when closed (~0.10) | `EAR < 0.21` ⇒ eyes closed |
| **PERCLOS** | fraction of a rolling 15 s window with eyes closed — the standard driver-fatigue metric | `PERCLOS ≥ 0.20` ⇒ drowsy |
| **Micro-sleep** | longest single continuous eye-closure in the window | `≥ 1.1 s` continuous ⇒ drowsy |
| **Blink rate** | closed→open transitions extrapolated to blinks/min | `≥ 28 bpm` ⇒ elevated (fatigue) |
| **Look-away** | sustained head yaw from landmark geometry | `|yaw| ≥ 26°` ⇒ inattentive |
| **Illumination** | mean frame luma (0–255) | `< 55` or `> 235` ⇒ poor capture |

Thresholds live in `web/src/lib/config.ts` (`DROWSINESS`, `GATES`). The logic is
in `web/src/face/attention.ts` (`AttentionMonitor`) and is pure/deterministic.

The live console shows these as gauges in **Frame inspection**; at verification
the current snapshot is captured into the attendance record:

```json
"inspection": {
  "ear": 0.12, "perclos": 0.31, "blinkRate": 22,
  "drowsy": true, "lookingAway": false,
  "yawDeg": 4, "pitchDeg": -2, "brightness": 140
}
```

## Operations console (backend `/admin`)

Server-rendered dashboard (`backend/src/dashboard.ts`), auto-refresh every 15 s,
passcode-gated via `ADMIN_PASSCODE`.

- **KPIs:** total events, unique subjects, liveness pass rate, average match
  distance, **drowsy events**, look-away events.
- **Match-distance sparkline** of recent events (lower = stronger match), bars
  coloured by flag.
- **Inspection ledger:** every record with EAR / PERCLOS / blink / yaw / light,
  and rows **highlighted** by severity — red for drowsy, amber for look-away,
  poor lighting, or weak match. Per-record flag chips summarise the issues.

## Bilingual prompts

On-screen guidance and liveness prompts are short **English / हिन्दी** static
strings (e.g. `Look straight / सीधा देखें`, `Blink / पलक झपकाएँ`) so field
personnel get native-language instructions with **no translation API** — the
flow stays fully offline.

## Privacy

No image or video leaves the device. Inspection metrics are scalar summaries
derived locally; only the verified record (id, time, distance, liveness, the
inspection summary, device id) is synced.
