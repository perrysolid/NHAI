# CLAUDE.md

Operating guide for agents working in this repo. Read this before changing code.

Deep reference lives in [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md)
(912 lines, per-file index). This file is the *contract*: invariants, commands,
model facts, the anti-spoof rules, and the scale architecture. Where the two
disagree, trust the code, then fix both.

---

## 1. What this is

Offline face authentication for NHAI field personnel (Datalake 3.0, Hackathon 7.0).
A React Native app enrolls and verifies an inspector's face **entirely on-device** —
detection, liveness, recognition, scoring, geofence — then queues a scalar
attendance record and syncs it to a backend only when the network returns.

**The cloud is never in the authentication path.** It is a sync-and-purge target
plus an admin console. No image, no video, and no raw frame ever leaves the device;
only 512-d embeddings (at enrollment) and scalar records (after verify).

Three deployables:

| Path | Role | Stack |
|---|---|---|
| `app/` | **The product.** Offline RN app, Android + iOS | RN 0.74.5, vision-camera 4.5, fast-tflite, ML Kit, MMKV |
| `backend/` | Sync target + admin API + SSR ops console | Node 18+, Express 4, ESM, Postgres / Supabase / memory |
| `web/` | Browser mirror — demo + admin dashboard | Vite, React 19, `@vladmandic/face-api` |

`web/` is **not** the scored deliverable and does **not** share code with `app/`.
It re-implements the same pipeline with different models (face-api 128-d
descriptors, Euclidean distance) and its own `web/src/lib/config.ts`. Changing a
threshold in one does not change the other — that duplication is deliberate but is
a standing source of drift.

---

## 2. Non-negotiable invariants

Break any of these and the product is wrong, not just buggy.

1. **Auth is offline.** Nothing in the enroll/verify path may await a network call.
   `web/src/lib/netMonitor.ts` wraps `fetch` and asserts zero calls during auth;
   the UI shows the counter. Keep it at zero.
2. **A replayed face must never authenticate.** See §5 — this is the invariant the
   whole liveness stack exists to protect, and the one most easily regressed.
3. **No biometric imagery is persisted or transmitted.** Embeddings only, in
   encrypted MMKV. If you find yourself writing a frame to disk outside
   `debug_imgs/` (gitignored, local debugging only), stop.
4. **`app/src/config.ts` is the single source of truth** for model specs,
   thresholds, and flags. Never hardcode an input size, normalization constant, or
   threshold in a worklet, a screen, or a test.
5. **Purge only on acknowledgement.** The local queue is cleared from
   `acceptedRecords` in the sync response, never optimistically.
6. **Never lower `THRESHOLDS.recognitionCosine` below 0.60** without re-measuring
   FAR/FRR on-device. It is the accept/reject line.

---

## 3. Commands

```bash
# ── app (primary) ──
cd app
npm install
npx jest                              # 126 unit tests
npx tsc --noEmit                      # type-check
npm run lint
npx react-native run-android          # needs JDK 17
cd ios && pod install && cd .. && npx react-native run-ios
cd android && ./gradlew assembleRelease   # ABI-split APKs -> app/build/outputs/apk/release/

# ── backend ──
cd backend
npm install && npm run build && npm start   # tsc -> dist/, node dist/index.js
npm test                                    # 38 tests, node:test via tsx
npm run typecheck                           # includes *.test.ts (build excludes them)
npm run dev                                 # tsx watch
# Refuses to start without API_KEY + ADMIN_USER + ADMIN_PASSWORD.
# Local demo without auth: ALLOW_INSECURE_NO_AUTH=1 npm start

# ── web ──
cd web
npm install && npm run dev
npm run build                          # tsc -b && vite build
npm run test:e2e                       # Playwright, 4 specs
```

**Current test state (verified):** `app` **126 passing**, `backend` **38
passing**, both stable across repeated runs; `tsc` clean in app / backend / web;
**0 lint errors** in app and web. App type-checks under **both** states of
`FLAGS.CALIBRATE_LIVENESS`.

`src/screens/__tests__/CameraScreen.test.tsx` has a history of intermittent
failure on the *"hands-free verify"* case, and it is a **real signal, not a flaky
test to retry away**. Its mocked face feeds a free-running yaw oscillation, so it
exercises turn-baseline edge cases a scripted mock would miss — that is how the
unsatisfiable-turn bug (§5, `turnBaselineMaxYawDeg`) was found. If it starts
failing again, debug the liveness state machine before touching the test, and
never "fix" it by widening the loop bound.

Backend tests use **`node:test` through `tsx`** — no test framework dependency.
`tsconfig.json` excludes `*.test.ts` so tests never reach `dist/`; run
`npm run typecheck` (tsconfig.test.json) to type-check them.

**Secrets are not committed.** `app/src/secrets.ts`, `backend/.env`, and
`web/.env` are gitignored; only `*.example` files are tracked. Copy
`app/src/secrets.example.ts` → `secrets.ts` before an on-device build or
`SYNC_URL` resolves to a placeholder.

---

## 4. Models

Three model families, one detector. All on-device, all open-source.

| Model | Role | Where declared | Input | Output | Bundled size |
|---|---|---|---|---|---|
| **EdgeFace-S** (TFLite, **float32**) | recognition | `RECOGNITION_MODELS.edgeface_s` | 112×112×3 RGB, `(px/255 − 0.5)/0.5` | 512-d, L2-normalized | **14.2 MB** |
| **MiniFASNetV2** (TFLite) | passive anti-spoof | `LIVENESS_MODEL` | 80×80×3 **BGR**, 2.7× bbox crop, **raw 0–255** (see below) | 3-class softmax, **index 1 = live** | **5.7 MB** |
| **ML Kit Face Detection** | detection, landmarks, blink/smile/pose | `useFaceDetector` in `CameraScreen.tsx` | camera frame | boxes, 5 landmarks, eye-open + smile probabilities, yaw/pitch | native SDK |
| MobileFaceNet (192-d) | *declared but not bundled* | `RECOGNITION_MODELS.mobilefacenet` | 112×112×3 | 192-d | — |
| face-api tiny detector + recognition | web mirror only | `web/public/models/` | — | 128-d descriptor | ~7 MB |

**Active model:** `ACTIVE_RECOGNITION = 'edgeface_s'` (`app/src/config.ts:51`).
Swapping it is a one-line change *plus* registering the asset in
`app/src/face/modelAssets.ts` — `RECOGNITION_ASSETS` currently maps **only**
`edgeface_s`. Setting `ACTIVE_RECOGNITION = 'mobilefacenet'` today throws at
`TfliteFaceEngine.load()`; the entry is a spec placeholder, not a working option.

### Documentation drift to be aware of

Several docs are stale on the model facts. The code is right:

- `README.md` and `docs/NHAI_HACKATHON_ALIGNMENT.md` claim **10.7 MB** of bundled
  models (MobileFaceNet 5.0 + MiniFASNet 5.7). Reality: **~19.9 MB**
  (EdgeFace-S float32 14.2 + MiniFASNet 5.7). Still under the 20 MB brief, but
  barely — INT8 or float16 EdgeFace is the headroom lever.
- `app/assets/models/README.md` and the README table describe EdgeFace-S as
  **INT8 (~1–2 MB)**. It is float32. Commit `400102a` switched away from INT8
  deliberately: *"switch to Float32 EdgeFace-S for accurate face matching."*
- `finetune/README.md` targets **float16 (~3.5 MB)** as the drop-in. That is the
  intended next step, not the current state.

If you re-quantize, you must re-verify I/O in [netron.app](https://netron.app),
update `RecognitionSpec.dtype`, and **force re-enrollment** — templates are not
portable across models (see §7).

### MiniFASNet expects raw 0–255, and this was a real bug

`LIVENESS_MODEL.std` is `[1/255, 1/255, 1/255]`, which makes `preprocessRgb`
(`px/255/std − mean/std`) emit **raw pixel values**. That looks wrong and is not.

Layer names inside the flatbuffer trace the model to DeepFace's vendored
`FasNetBackbone`, itself a verbatim copy of Minivision's Silent-Face — where
`ToTensor` is **not** torchvision's but their own, with the `.div(255)` line
commented out (`modify by zkx`). The docstring still claims `[0,1]` and is simply
wrong. The network was trained on 0–255.

Feeding 0–1 made every activation 255× too small. **Measured on the actual
model:** live-probability was pinned at ~0.007 for *any* input — std 0.0004
across 40 wildly different inputs. It was not scoring real faces low, it was a
constant function, which is why no threshold ever worked. At 0–255 it
discriminates (face-like blob 0.79, high-frequency grid 0.001).

The `channelOrder: 'bgr'` and `liveClassIndex: 1` were correct all along —
`cv2.imread` with no `cvtColor` upstream, and `argmax == 1` in `test.py`. Don't
re-suspect them.

Two known-remaining mismatches with upstream, worth fixing if separation is poor:
upstream crops a **rectangular** `box_w × 2.7, box_h × 2.7` and squashes it to
80×80, while `faceCrop` uses a square `max(w,h)`; and upstream sums **two**
models (V2 @2.7 + V1SE @4.0) — only the V2 is bundled, so any threshold quoted
for Silent-Face is an ensemble threshold and does not transfer.

### Threshold rationale (don't tune blind)

`recognitionCosine: 0.65` for EdgeFace-S 512-d ArcFace features. Genuine pairs
land 0.70–0.95, impostors peak 0.30–0.55; 0.65 sits in the separation gap.
`SCORING.confidenceSteepness: 12` maps cosine → 0..1 confidence with a logistic
centred on that threshold.

### Fine-tuning

`finetune/EdgeFace_IndicFairFace_finetune.ipynb` — ArcFace fine-tune on IMFDB
(identity-labelled, 100 identities), demographic evaluation on IndicFairFace
(bias-measurement set, evaluation only — never train on it). Every risky cell has
a sanity assert including TFLite↔PyTorch cosine > 0.999. The >95% accuracy claim
in the brief is **not yet independently measured**; treat it as a target.

---

## 5. Anti-spoof: the replay contract

> **A face that is not physically present in front of the camera must never
> authenticate.** This includes a printed photo, a face on another phone's screen,
> a pre-recorded video, and **a live video call relayed to the camera.** The
> system must *bifurcate* — live human on one side, every reproduction on the
> other — and a reproduction must not be accepted as a detection of the enrolled
> person.

This is the requirement most likely to be silently broken by a "helpful" change,
because every defence here trades against false-rejecting real users in bad light.

### Threat model vs. current defence

| # | Attack | Defeated by | Status today |
|---|---|---|---|
| 1 | **Printed photo** held to camera | Blink requires an eye-open swing ≥ `livenessMotionRange` (0.2); a flat reading cannot pass (`livenessActions.ts:83`) | ✅ Blocked |
| 2 | **Static image on a screen** | Same as (1), plus randomized smile/turn | ✅ Blocked |
| 3 | **Pre-recorded video** of the target | `ActiveLivenessChallenge` picks `livenessActionCount` (2) actions from a 4-action pool in a **random order per attempt**, gated step-by-step, each with its own deadline | ⚠️ **PARTIAL** — slow loops blocked, tight loops are not. See "the looping-video result" below |
| 4 | **Screen/moiré texture** (any replay medium) | MiniFASNet passive score < `livenessPassiveFloor` (0.3) | ⚠️ **DISABLED** — `FLAGS.PASSIVE_SCREEN_BLOCK = false` |
| 5 | **Live video call relay** — accomplice on a video call performs the challenge in real time | Per-action response deadline — a live human satisfies any behavioural challenge, but cannot escape the relay's round-trip latency | ⚠️ **PARTIAL** — deadlines land at 4–5 s pending on-device calibration; tighten toward ~2.5 s |
| 6 | **Virtual-camera / frame injection** — feed synthetic video into the camera stream, bypassing the lens | *Nothing* — no capture-provenance or device-integrity check exists | ❌ **NOT BLOCKED** |

### The looping-video result (measured, not assumed)

A recording that cycles all four gestures and is simply replayed on a loop was
simulated against the real `ActiveLivenessChallenge` (400 trials per period,
random loop phase, sampled at `challengeTickMs`):

| Loop period | Pass rate |
|---|---|
| 1.5 s | **100%** |
| 2.5 s | **100%** |
| 4 s | **95%** |
| 6 s | 52% |
| 10 s | 14% |
| 20 s | 4% |

Read that carefully, because it is the opposite of the intuition. Randomizing
*which* actions and *what order* does **not** stop a loop that contains every
gesture — the loop will present whatever is demanded soon enough. What decides
the outcome is the per-action deadline versus the loop period: if the loop cycles
faster than the deadline, every demanded gesture is guaranteed to appear inside
its window, so the attack succeeds essentially always.

So the deadline blocks **slow and naive** loops (a 20 s loop drops from near-certain
success under the old shared 30 s window to 4%) and does nothing against a
**deliberately tight** one. Tightening the deadline toward 2.5 s narrows the band
of loop periods that fail — it does not close the attack, it only forces the
attacker to build a shorter loop, which is easy.

**The behavioural challenge cannot solve this.** A loop shorter than the deadline
beats it by construction, exactly as a live relay does. What actually stops both
is detecting the *display medium* rather than the behaviour: passive PAD, moiré/DFT,
or flash reflection. All are currently off or unimplemented. Do not describe
pre-recorded video as blocked without this caveat.

Regression-tested in `liveness.test.ts` ("blocks a SLOW looping video…"), which
pins the slow-loop case so removing the deadline is caught.

### Why (4) is off, and what it costs

`FLAGS.PASSIVE_SCREEN_BLOCK = false` and `FLAGS.REQUIRE_PASSIVE_LIVENESS = false`
(`config.ts:31,42`). The bundled MiniFASNet scores **real** faces below the floor
on the test hardware, so enforcing it false-rejected live users and broke verify.
The passive score is still computed, recorded on every record, and shown in the
UI — it is advisory, not blocking.

**Consequence:** the randomized behavioural challenge is currently the *only*
anti-spoof. That is sufficient for threats 1–3 and structurally insufficient for
4–6. Do not describe the system as replay-proof without this caveat.

**The cause was found: a 255× input-scaling bug, now fixed** (see §4). The model
was emitting a constant, so it could never have separated anything. What remains
is genuine calibration: score real faces and screen replays on target hardware,
put `livenessPassiveFloor` in the measured gap, then flip
`PASSIVE_SCREEN_BLOCK`. The passive score is shown on the verdict line for both
pass and fail, so collecting it needs no special build.

Watch for a false-accept bias while calibrating: 40 random colour-noise inputs
averaged **0.994 live**. If real faces and screen replays do not separate, the
model is wrong for this hardware — swap to the 600 KB
[facenox](https://github.com/facenox/face-antispoof-onnx) MiniFAS variant
(Apache-2.0, RGB, square 1.5× crop, 128², 2 logits) rather than tuning a
threshold that isn't there. Treat mis-calibrated passive liveness as a *bug*,
never as a reason to delete the defence.

### Rules for anyone touching liveness

- **Never** make the challenge deterministic, cache the action order, or reduce
  `livenessActionCount` to 1. Randomization *is* the defence against (3).
- **Never** relax `livenessMotionRange` — it is what separates a blink from a
  photo. Loosen `blinkClosedProb`/`blinkOpenProb` for camera sensitivity instead.
- **`LIVENESS_ACTION_DEADLINE_MS` is a total Record and `deadlineForAction()`
  has no `??` fallback.** Adding an action without a deadline is a compile error
  (verified). Don't "helpfully" add a default — it would convert that compile
  error into a silent runtime guess for a value that decides whether a relay
  attack succeeds.
- **Turns are verified as a delta from a baseline, never as an absolute angle.**
  The motion is the security property; an absolute threshold would let a photo
  held at a tilt satisfy "turn left" without moving. The baseline is only latched
  once the head is frontal (`turnBaselineMaxYawDeg`) — latching it mid-turn puts
  the target outside the ±`maxYawDeg` gate and makes the action *physically
  unsatisfiable*, which reads as "the app is broken", not "liveness failed".
- **Never** remove the `evaluateDualLiveness` AND. If passive is re-enabled it
  must be an AND with active, not a fallback.
- A liveness failure **still queues a record** with `livenessPassed: false` and
  increments the lockout counter (`recordLivenessAttempt`). Failed attempts are
  evidence; do not drop them.
- Escalating lockout: 5 failures in 5 min → 60 s, doubling per lockout
  (`LIVENESS_LOCKOUT`). Persisted in MMKV, so it survives an app restart.

### Closing 5 and 6 (researched roadmap)

**The behavioural ceiling.** Any challenge a human can perform on command, a
human on a video call can also perform on command — and current real-time
deepfake engines take blink/smile/turn as parameters. This is a *category limit*,
not a threshold to tune.

**Randomized counts ("smile twice") do not help. Measured, not assumed.** The
intuition is that a loop cannot repeat on demand. It can. Requiring N repetitions
forces the deadline UP, because a real user needs `prompt overhead + N × ~1 s`
to comply — and the loop spends that same extra time cycling. Pass rate for a
looping video, deadline scaled to keep genuine users passing:

| N | deadline | 1 s loop | 2 s loop | 3 s loop | 4 s loop |
|---|---|---|---|---|---|
| 1 | 3.5 s | 100% | 100% | 100% | 100% |
| 2 | 4.5 s | 100% | 100% | 79% | 40% |
| 3 | 5.5 s | 100% | 98% | 6% | 0% |
| 4 | 6.5 s | 100% | 50% | 0% | 0% |

Counting only bites when the loop is *slow*, and the attacker picks the speed.
The floor is set by detection, not by counting: a blink still registers reliably
at a **1 s** loop period (100% within 5 s; it only degrades below ~800 ms, where
the closed phase falls between samples). Against a 1 s loop, every count from 1
to 4 passes 100% of the time — while costing a real inspector a 6.5 s challenge.

So counts buy nothing against the attack they look designed to stop, and cost
real BPCER. Skip them.

To beat a relay you must stop challenging *the person's behaviour* and start
challenging *the physics of the capture*. In effort/return order:

1. **Calibrate MiniFASNet and re-enable passive PAD (4).** The 255× scaling bug
   that made it useless is **fixed** (§4); what remains is measuring the floor.
   Free — the model is bundled, and the passive score is now on the verdict line
   for both pass and fail, so no special build is needed. Catches the *display
   medium*, present in 4 and 5 alike: a relayed video call is still a screen in
   front of a lens. If real faces and screen replays don't separate, swap to the
   600 KB facenox variant rather than tuning a threshold that isn't there. That
   swap also frees ~5 MB of the 19.9/20 MB model budget, which is what unblocks
   everything else.
2. **Per-action response deadline (5). ✅ IMPLEMENTED.** Each action now carries
   its own deadline measured from the moment it is demanded
   (`LIVENESS_ACTION_DEADLINE_MS`, `deadlineForAction()`), with
   `activeChallengeTimeoutMs` demoted to a backstop. Missing it fails the whole
   attempt. This is the timing-asymmetry principle behind Face Flashing (NDSS
   2018): a genuine response costs ~nothing, a relayed one costs a round trip.
   The clock deliberately does **not** pause when the face leaves frame —
   otherwise stepping out of shot buys the attacker free time.

   Defaults are **4 s (blink/smile) / 5 s (turns)** — deliberately loose. Every
   prompt is *spoken* (`speech/tts.ts` at rate 0.5, deliberately slow) and users
   wait for the voice line before acting, so the 1.5–2 s figure the research
   suggests would false-reject real inspectors. **These are guesses until
   measured on a real device** — until then the defence is only partial.

   **Calibration harness — `face/livenessCalibration.ts`** (full runbook in the
   file header). Flip `FLAGS.CALIBRATE_LIVENESS`, run ~30 genuine attempts, read
   Settings → CALIBRATION → "Show timing report" (or `[CALIB]` in logcat). It
   reports n / expired / p50 / p95 per action against the current deadline and
   emits a copy-pasteable `LIVENESS_ACTION_DEADLINE_MS` block. Guardrails worth
   knowing: it refuses to recommend below 2500 ms whatever the data says (a
   sample of confident testers who already know the prompt will happily suggest
   1200 ms), marks any action under 12 samples as low-confidence, and flags
   "TOO TIGHT" when >10% of genuine attempts are expiring. Recording is
   best-effort and can never fail a verify. **Turn the flag off before shipping.**

   Two things the harness cannot tell you: whether the deadline still admits a
   *relay* (film a video call performing the challenge and re-measure — a
   deadline tuned only against genuine users may have bought nothing), and
   whether your test group represents the field. Every second removed comes
   straight out of the attacker's budget, so tighten as far as the data allows.
3. **Screen-flash spatial confinement (4, 5, 6) — the real fix.** Flash the
   screen, then compare the normalized response
   `S = (I_flash − I_dark)/(I_flash + I_dark)` between the **face region** and the
   **background**. Under a Lambertian model the surface reflectance `K` cancels in
   that ratio, so it is *skin-tone invariant* while still encoding `cos θ` — the
   reason to use this form rather than a raw difference. Then:

   | | face | background | `R = face/bg` |
   |---|---|---|---|
   | Live face (30 cm, background 1–3 m, 1/d² falloff) | strong | ≈0 | **large** |
   | Screen or print held up — a flat panel at uniform distance | strong | strong | **≈1** |
   | Injected / virtual-camera stream | ≈0 | ≈0 | undefined |

   Gate on **two** scalars: face response above a floor (catches injection — the
   one thing that touches threat 6) *and* `R` above a threshold (catches flat
   panels). Add a plane-fit residual over `S` for 3D structure: a panel is a
   plane, a face lit from 30 cm is not. This is LiveScreen (Rutgers, INFOCOM
   2020), pure JS on the existing 256 px buffer — no model, no bytes.

   **The torch cannot be used. Front cameras have no torch** — `hasTorch` is
   false and vision-camera *throws*. `robustness/lighting.ts`'s `shouldUseTorch`
   is unimplementable, not merely unwired. The illuminant must be the screen,
   which needs native brightness control (`WindowManager.screenBrightness`,
   window-scoped, **no permission**; `UIScreen.main.brightness` on iOS).

   **Validate AE/AWB lock FIRST — everything depends on it.** Auto-exposure
   compensates for the flash and cancels the signal being measured, and
   vision-camera 4.5 exposes only exposure *bias*, no lock. Expect a
   `patch-package` on `CONTROL_AE_LOCK`/`CONTROL_AWB_LOCK`. If that proves
   impossible, this whole family of methods is unimplementable — find out before
   writing descriptor code.

   **Do not attempt corneal-glint matching.** At 30 cm a phone screen reflects to
   ~11% of iris width, and at `mediumLongEdge = 256` the iris is ~9 px — so the
   reflected image is **about one pixel**. The published two-eye IoU threshold
   also assumes a *distant* source, which a phone at arm's length is not. SpecDiff
   still gives us the descriptor form above; its iris term does not survive our
   resolution.
4. **Randomized colour + a ~150 ms response window (5) — the actual relay
   defence.** Pick the flash colour per attempt at random from {R,G,B,W}, never
   cached, and require the response in the *flashed channel* to appear in the
   frames whose timestamps fall inside the flash window.

   **This is the structural answer to a live relay, and it costs zero BPCER.**
   A live face responds at the speed of light; the only delay is camera pipeline
   latency, constant per device and measurable once. A relay must additionally
   encode → transmit → decode → re-encode, measured at **100–500 ms**. So the
   attacker's budget drops from the 4–5 s behavioural deadline to roughly one
   camera frame — and unlike tightening `LIVENESS_ACTION_DEADLINE_MS`, the user
   does nothing, so there is no false-reject cost. Red is the strongest channel
   for skin; even a +10% red boost gave >80% detection in LiveScreen.

   Prefer a **two-colour differential** (colour A ~200 ms, then colour B at
   matched luminance) over flash-vs-dark: identical ambient and identical total
   luminance in both frames, so ambient *and* the flash DC cancel, leaving a pure
   chromatic response. Better conditioned, and still inside ~500 ms.

   Requires AWB lock, or auto-white-balance neutralises the very colour cast
   being measured. And note the ceiling: offline, the sequence is generated and
   checked on the same untrusted device — iProov does both in the cloud
   *specifically* for that reason. Raises the bar hugely against the realistic
   field attack; not a cryptographic guarantee.
5. **Device integrity / capture attestation (6).** Play Integrity API on Android,
   DeviceCheck/App Attest on iOS; root and emulator detection; refuse external and
   virtual camera devices — `useCameraDevice('front')` should assert a physical
   front sensor. The only real defence against injection: if you cannot prove the
   pixels came from a physical lens, assume they are synthetic.
6. **Moiré / DFT screen detection (4, 5).** Aliasing between a display's pixel
   grid and the camera sensor is a replay-specific artifact, detectable via a
   high-frequency ratio in the Fourier domain. Cheap, no model, good complement —
   but defeated by high-quality displays at the right distance.

**Rejected for this deployment, with reasons** (don't re-propose these):

- **Depth / TrueDepth.** iPhone-only. Face ID's depth maps go to the Secure
  Enclave and are not available to third-party apps for auth; ARKit face tracking
  gives geometry but no liveness attestation and is iOS-only. The Android
  structured-light wave (Oppo, Huawei, Xiaomi, ~2018) died on cost and UX, and
  **mid-range Android — the actual target hardware — has no front depth sensor.**
  Depth forks the codebase to protect the users who aren't in the field.
- **rPPG (pulse from skin colour).** Genuinely detects blood flow, but needs ~10 s
  of stable video and degrades badly with motion, outdoor light, and lower SNR on
  darker skin tones; high-quality replay can carry the source's rPPG through.
  Wrong fit for a sub-second outdoor field check.

**Architectural ceiling — state this honestly, don't let it be discovered.**
iProov verifies its flash sequence **in the cloud** specifically so the check
cannot be tampered with. This system is offline by design, so every check runs on
a device it does not trust, and a rooted phone can patch a local verification
result. Flash challenges still raise the bar enormously against the realistic
field attack, but *offline + untrusted device* is a hard ceiling on assurance. It
is a design tension, not a bug to fix.

Standards context: ISO/IEC 30107-3 covers presentation attacks (1–5) only. A
system can be Level-3 certified and still have **no defence against a virtual
camera** — injection attacks are governed separately by CEN/TS 18099, with
ISO/IEC 25456 still in development. If a claim about spoof resistance goes in a
deck or a report, scope it to the attack class actually tested.

---

## 6. Pipeline walkthrough

Where to look when something in the auth path misbehaves.

```
Camera frame (vision-camera, throttled to CAMERA.targetFps = 8)
  └─ frameProcessor worklet (CameraScreen.tsx:663)
       ├─ ML Kit detectFaces → boxes, landmarks, eye/smile probs, yaw/pitch
       ├─ resize() → 64px proxy for mean-luma brightness
       └─ resize() → mediumLongEdge (256px) full-FOV RGB buffer  ── no crop here
  └─ onSignals (JS thread, CameraScreen.tsx:564)
       ├─ evaluateFace() → quality gate  (camera/qualityGates.ts)
       │    one face · ratio ≥ 0.09 · |yaw|,|pitch| ≤ 45° · luma 25..252
       ├─ enroll mode: isActionSatisfied(step) → auto-capture that sample
       └─ verify mode: gate ready → auto-start ActiveLivenessChallenge
  └─ runVerify (CameraScreen.tsx:1048)
       ├─ buildBestCrop → faceAlign.ts (5-pt ArcFace warp, 'aligned') when the
       │    detector returned landmarks; else faceCrop.ts rotated box ('boxRot')
       ├─ Promise.all:  embedFace(112² recog crop) ‖ scoreLive(80² 2.7× crop)
       ├─ store.verify(probe) → cosine vs every local template
       ├─ evaluateDualLiveness(passive, active)
       ├─ computeComposite() → Authentication Score 0..100
       ├─ evaluateGeofence(fix, sites) → presence signal, NOT identity
       └─ queueAttendance() → encrypted MMKV queue
  └─ syncPending() when online → POST /api/sync → purge acknowledged records
```

**Cropping is the highest-risk area in the codebase.** Two hard-won facts, both
documented in-file, both regression magnets:

- The worklet does a **plain full-frame downscale only**. The resize plugin's own
  `crop` option is applied in the *rotated sensor buffer* on Android, so a crop
  computed in frame coordinates lands out of bounds and returns an empty buffer.
  Cropping happens in pure JS afterwards (`camera/faceCrop.ts`) — deterministic
  and unit-testable.
- The front sensor buffer is landscape while the phone is portrait, so faces
  arrive rotated 90°. `CAMERA.recognitionRotationDeg = 90` re-uprights the
  sampling grid. Recognition models are trained on upright faces; a sideways crop
  was the root cause of *"different people match / the same person's score swings
  0.77–0.95."* The 5-point ArcFace alignment in `faceAlign.ts` subsumes this when
  landmarks are available.

**Composite Authentication Score** — recognition 0.45, liveness 0.25, alertness
0.10, pose 0.10, illumination 0.10; below 70 is flagged low-trust for review.
Mirrored in `app/src/face/scoring.ts` and `web/src/lib/scoring.ts`; keep them
identical.

**Geofence is never an identity signal.** It stamps
`lat/lon/accuracy/mocked/geofencePassed/siteId/distanceM` on the record and only
blocks when `GEOFENCE.enforce` is true (currently `false`, because `SITES` is
intentionally empty — a hardcoded default coordinate would make every phone
outside that city read "not in zone"). Mock-provider fixes are rejected.

---

## 7. Conventions and known traps

- **Embedding-dimension mismatch is silent-ish.** `OfflineAuthStore.listEnrollments()`
  filters out every template whose length ≠ the active model's, and warns. After a
  model swap, users see "no enrollments" and must re-enroll. `cosineSimilarity`
  throws a deliberately user-readable error on mismatch. This is correct
  behaviour — don't "fix" it by padding or truncating vectors.
- **`APP_VERSION` drifts.** `CameraScreen.tsx:127` says `v3.0 · build 22`;
  `android/app/build.gradle` says `versionName 4.2 / versionCode 35`. The gradle
  values are authoritative for releases. Update both.
- **MMKV encryption key is hardcoded** — `'replace-with-device-keychain-secret'`
  in `auth/mmkvStore.ts`. It must come from the platform keystore/keychain before
  any real deployment. Flagged in §8.
- **Pure functions stay pure.** `qualityGates`, `faceCrop`, `faceAlign`,
  `scoring`, `math`, `geofence`, `attention`, `livenessActions` have no native or
  worklet dependency and are unit-tested. Keep new logic in that shape.
- **Adding a liveness action:** id → `LIVENESS_ACTIONS`, state →
  `freshActionState`, case → `isActionSatisfied`, text → `i18n.ts` `LIVENESS_TEXT`.
  Enrollment (iterates all) and verify (samples a subset) pick it up automatically.
- **Backend is ESM** (`"type": "module"`) — relative imports need the `.js`
  extension even in TypeScript source. Match the existing style.
- **`app/src/robustness/lighting.ts` is dead code, and its `shouldUseTorch` is
  unimplementable.** Nothing imports it outside its own test. Worse than unwired:
  **front cameras have no torch**, so that recommendation can never be consumed
  (§5, item 3). `stretchLuma()` is genuinely usable but never called, so there is
  no contrast normalization in the running pipeline — the README's "CLAHE/torch
  robustness" claim for outdoor lighting is unbacked. Drop `shouldUseTorch`,
  repoint any flash work at the *screen*, and either wire `stretchLuma` or drop
  the claim.
- `docs/SHARDING_PROXY_INTEGRITY.md` documents a Cloudflare Worker at
  `backend/src/proxy-worker.js`. **That file does not exist.** The edge proxy is a
  design, not an implementation.

---

## 8. Deploying at scale

The current backend is a hackathon-shaped single Express process. It is correct
in its data model and wrong in its execution shape for a large fleet. This
section is the gap list, in dependency order, with the reasoning that produced it.

### The load is bursty by construction

Offline-first inverts the usual traffic curve. Devices do not sync when they
verify — they sync when connectivity returns, and connectivity returns in
correlated clusters (end of shift, back in town, depot Wi-Fi). Sizing for the
average is the classic mistake here.

For N = 100,000 field devices at 4 verifies/day: 400k records/day ≈ **4.6 writes/s
average**. But if 30% of the fleet reconnects inside the same 15-minute window and
each flushes a day's queue, that same load arrives as **~130 writes/s sustained**
with a much higher instantaneous peak — a **~30×** burst factor over average, and
that is a conservative clustering assumption. Design the write path for the burst,
not the mean.

The good news: the payload is tiny (scalar records, ~300 bytes), the operation is
idempotent, and nothing is latency-sensitive — a record may land seconds or
minutes late with zero user impact. That combination is exactly what buffering and
async processing are for.

### Blockers before multi-instance (must fix first)

These are not optimizations; they are *correctness* failures the moment a second
instance exists.

1. **Admin sessions are in-process.** `backend/src/auth.ts` keeps
   `adminTokens` in a module-level `Set`. Two instances behind a load balancer →
   a token issued by one is rejected by the other, and every restart logs
   everyone out. **Fix:** stateless signed tokens (JWT with short TTL + rotation)
   or a shared session store (Redis). This is the single hardest blocker to
   horizontal scaling.
2. **Rate limiting is coupled to persisted rows, and races.** The per-device
   30/min guard in `store.guard()` counts rows already in the table
   (`WHERE device_id = … AND ts > now − 60s`), so it *is* shared across instances
   — but it costs an extra query per sync, it cannot throttle traffic that never
   reaches the DB, and concurrent batches from one device each read a
   pre-insert count and can both pass. `MemoryStore`'s equivalent, and the
   edge-proxy limiter documented in `docs/SHARDING_PROXY_INTEGRITY.md`, are
   genuinely per-process — that doc admits the worker's counters are per-instance.
   **Fix:** a distributed token bucket keyed by `deviceId` (Redis or the edge),
   enforced *before* the origin, leaving `store.guard()` as a last-resort
   backstop rather than the primary limiter.
3. **Two secrets are baked into the binary, identically for every device.**
   - The device credential is a single shared API key (`app/src/secrets.ts` →
     `x-api-key`). `secrets.example.ts` already admits it: *"any value baked into
     a mobile binary is still extractable."* One extracted key compromises the
     whole fleet and cannot be revoked without shipping a new build.
   - The MMKV encryption key is the literal string
     `'replace-with-device-keychain-secret'` (`app/src/auth/mmkvStore.ts`), so
     every device encrypts its biometric templates with the same known key —
     which is to say, not meaningfully encrypted at all.

   **Fix:** per-device credentials issued at enrollment and revocable
   individually, ideally bound to a platform attestation (§5, closing item 2);
   and a per-device MMKV key generated on first run into the Android
   Keystore / iOS Keychain. Both are hard blockers for a real rollout, not
   hardening niceties.

### Write path

4. **`store.add()` inserts one row per round trip** in a `for` loop
   (`store.ts:299`). A 50-record batch is 50 sequential network round trips to
   Postgres. **Fix:** single multi-row `INSERT … VALUES (…),(…),… ON CONFLICT DO
   NOTHING RETURNING *` — one round trip, same idempotency, same return shape.
   Roughly a 50× reduction in DB round trips on the batch path.
5. **`store.guard()` on Supabase is O(users + devices) sequential queries** per
   request, and pulls *every* historical row for each user to compute a max
   timestamp in JS (`store.ts:486`). The code comments admit this. **Fix:** a
   single Postgres RPC doing the `GROUP BY` server-side — the `PostgresStore`
   variant already does this correctly and is the model to copy.
6. **No buffering between HTTP and the database.** A reconnect burst hits
   Postgres directly with no shock absorber. **Fix:** accept → append to a durable
   queue (SQS/Kafka/Redis Streams) → 202 → drain with a bounded worker pool. The
   records are idempotent on `(user_id, ts, device_id)`, so at-least-once delivery
   is safe and redelivery is free. This is the highest-leverage change for burst
   tolerance.
7. **No backoff or jitter on the client.** `syncClient.syncPending()` posts once
   and returns; retry is left to the caller, and the caller has no jitter. A
   depot full of phones joining the same Wi-Fi produces a synchronized thundering
   herd. **Fix:** exponential backoff with full jitter on the device, plus honour
   `Retry-After` on 429/503. `CameraScreen` already has a `RETRY_DELAYS` ladder
   for site fetch — generalize that pattern and add randomization.
8. **A batch is capped at 50 and one call sends one batch.** A device offline for
   a week needs many invocations to drain. **Fix:** loop until the queue is empty
   or the server pushes back.

### Read path and storage

9. **No index on `ts`.** The schema (`store.ts:269`) declares
   `PRIMARY KEY (user_id, ts, device_id)` and nothing else, but `list()` runs
   `WHERE ts >= $1 ORDER BY ts DESC LIMIT $2` — the dashboard's main query. With
   hash partitioning that is a full scan of all 8 partitions on every admin page
   load. **Fix:** `CREATE INDEX ON attendance (ts DESC)` per partition. Cheap,
   immediate, do it first.
10. **Hash partitioning is the wrong axis for the actual query mix.**
    `migrate-partitions.sql` partitions by `HASH(user_id)` — ideal for
    "one inspector's history", which is not what the dashboard asks for. Every
    time-range query fans out across all partitions, and old data can never be
    dropped cheaply. **Fix:** partition by `RANGE(ts)` monthly, hash-subpartition
    on `user_id` if per-user locality still matters. Monthly ranges give partition
    pruning on the dominant query *and* make retention a `DROP TABLE` instead of a
    mass `DELETE`.
11. **`GET /api/records` has no real pagination.** `since` + `limit ≤ 1000` cannot
    page backwards through history. **Fix:** keyset pagination on `(ts, user_id,
    device_id)` — the primary key already supports it.
12. **Retention and residency are undefined.** Attendance records accumulate
    forever. Enrollment embeddings are biometric data under India's DPDP Act 2023;
    they are stored server-side (`/api/enroll`) with no stated encryption at rest,
    retention limit, or deletion path beyond the admin `DELETE`. **Decide and
    document** retention windows before rollout — this is a compliance blocker,
    not a nice-to-have.

### Edge, delivery, and operations

13. **The edge proxy is unimplemented** (§7). It is the right design — key
    validation, rate limiting, and caching `GET /api/sites/for/:userId` at the
    edge keeps the origin free for writes. Site assignments change rarely and are
    read on every app foreground; that endpoint is nearly free to cache and
    otherwise scales linearly with fleet size.
14. **Auth now fails CLOSED. ✅ FIXED.** `apiKeyGuard` and `adminGuard` used to
    wave every request through when their env vars were unset, so a deploy that
    forgot `ADMIN_USER`/`ADMIN_PASSWORD` served the whole attendance registry
    unauthenticated with nothing to reveal it. Missing credentials now return
    **503**, and `assertAuthConfigured()` makes the process **refuse to start**,
    naming exactly what is absent. `ALLOW_INSECURE_NO_AUTH=1` is the single,
    explicit opt-out for local demos — never set it on a deployed instance.
    Covered by `src/auth.test.ts`.
    **Still open:** `CORS_ORIGIN` unset defaults to `*`.
15. **Observability is one `console.log` per request.** No metrics, no tracing,
    no alerting. At fleet scale you need at minimum: sync accept/reject rates by
    reason (the integrity guard's rejections are a *security* signal — a spike
    means tampering or a clock bug), p50/p95/p99 write latency, queue depth,
    per-device error rates, and model-inference latency reported from the device.
    `/health` exists and is wired to the Render health check — keep it, add
    `/ready` distinguishing "process up" from "database reachable".
16. **Model updates have no delivery path.** Models are bundled in the APK, so a
    re-quantized or fine-tuned model means a full app release *and* a forced
    re-enrollment of every user (§7). At 100k devices that is a migration, not a
    deploy. **Fix:** version templates alongside the model, support dual-template
    storage during a transition window, and re-enroll opportunistically at the
    next successful verify rather than all at once.

### What is already right

Worth preserving — these are good decisions, not accidents:

- **The natural idempotency key** `(user_id, ts, device_id)` with `ON CONFLICT DO
  NOTHING` makes retries and at-least-once delivery safe end to end. Everything in
  the queueing recommendation above depends on it.
- **The auth path has no cloud dependency**, so backend downtime degrades sync,
  never authentication. That is the strongest availability property the system
  has — the offline-first constraint accidentally produced excellent failure
  isolation. Do not let a "quick server-side check" erode it.
- **Server-side integrity guard** (score sanity, monotonic timestamps, per-device
  rate limits, cross-device timeline collisions) correctly assumes the device is
  untrusted, and runs *before* `add()` so rejected records never occupy a primary
  key slot.
- **The store interface** cleanly abstracts memory / Postgres / Supabase, so
  swapping the persistence layer is contained.
- **Health check + ABI-split APKs + stateless request handling** (apart from the
  two in-process caches above) mean the service is close to horizontally
  scalable — items 1 and 2 are genuinely the only structural blockers.

---

## 9. Backend API surface

Two independent credentials, both sent as `x-api-key`. `apiKeyGuard` checks the
shared device `API_KEY`; `adminGuard` checks an in-memory token from
`/api/admin/login`. **The key baked into the app binary does not grant admin
access** — keep it that way. Both guards **fail closed**: unset credentials
return 503 and the process refuses to start (§8, item 14).

| Route | Guard | Purpose |
|---|---|---|
| `GET /` | none | HTML status page |
| `GET /health` | none | liveness probe (Render/AWS health check) |
| `POST /api/sync` | device | `{records:[…]}` → `guard()` → `add()` → `{accepted, received, rejected, acceptedRecords}` |
| `GET /api/records` | **admin** | recent records, `since` + `limit ≤ 1000` |
| `POST /api/admin/login` | none | `{username,password}` → ephemeral hex token |
| `POST /api/enroll` | device | upsert `{userId, role, embedding[], deviceId}` |
| `GET /api/enrollments` | admin | full registry |
| `GET /api/enrollments/for/:userId` | device | pull a template to verify that inspector offline |
| `DELETE /api/enrollments/:userId` | admin | remove |
| `GET /api/roles` | none | role list for the admin form |
| `GET /api/sites` · `POST /api/sites` · `DELETE /api/sites/:id` | admin | geofence CRUD |
| `GET /api/sites/for/:userId` | device | assigned sites, cached in MMKV for offline use |
| `GET /admin?key=…` | `ADMIN_PASSCODE` | SSR ops console (`dashboard.ts`) |

Note `POST /api/enroll` accepts a raw biometric template over the device
credential — see the retention/residency gap in §8, item 12.

## 10. Docs map

| File | What it's for |
|---|---|
| `docs/TECHNICAL_DOCUMENTATION.md` | The deep reference — per-module detail + file index. Start here for "how does X work". |
| `docs/NHAI_HACKATHON_ALIGNMENT.md` | Requirement matrix **and an honest known-gaps list**. Read before making a compliance claim. |
| `docs/SHARDING_PROXY_INTEGRITY.md` | Sharding, edge proxy, integrity guard. Proxy is unimplemented (§7). |
| `docs/MONITORING_AND_DASHBOARD.md` | Drowsiness/attention metrics and the ops view |
| `docs/AWS_DEPLOYMENT.md` · `docs/WEB_RENDER_DEPLOYMENT.md` · `docs/SUPABASE.md` | Per-target deploy steps |
| `docs/DATALAKE_INTEGRATION_GUIDE.md` | Datalake 3.0 record contract |
| `docs/IMPLEMENTATION_PLAN.md` · `docs/TEST_REPORT.md` | Historical; may be stale |
| `finetune/README.md` | EdgeFace-S → IndicFairFace fine-tune → TFLite pipeline |

## 11. Deployment surfaces

| Target | Mechanism | Notes |
|---|---|---|
| Backend → Render | `render.yaml` blueprint | `rootDir: backend`, `/health` check, generates `API_KEY` + `ADMIN_PASSCODE` |
| Backend → AWS | `backend/Dockerfile`, `apprunner.yaml` | App Runner / ECS / EB / EC2; see `docs/AWS_DEPLOYMENT.md` |
| Web → Vercel | `web/vercel.json` | SPA rewrites for `/operations`, `/deployment`, `/aws` |
| Store | `DATABASE_URL` → Postgres; `SUPABASE_URL`+`SUPABASE_SERVICE_KEY` → Supabase; neither → **in-memory (data lost on restart)** | Supabase takes precedence |
| App | Gradle release, ABI splits `armeabi-v7a` + `arm64-v8a`, `minSdk 26`, `targetSdk 34` | iOS floor is **15.5** (ML Kit requirement), above the brief's iOS 12 |

Env vars: `API_KEY`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_PASSCODE`,
`CORS_ORIGIN`, `DATABASE_URL` | `SUPABASE_*`, `PORT`.
Web build-time: `VITE_SYNC_URL`, `VITE_SYNC_KEY`.

---

## 12. Working agreements

- **Don't commit the large binaries.** `docs/deliverables/*.apk` (60–80 MB each)
  are already tracked; don't add more. Models are gitignored by extension
  (`*.tflite`, `*.onnx`, `*.pt`) — `app/assets/models/*.tflite` is a deliberate
  exception, so check `git status` before assuming a model is tracked.
- **No `Co-Authored-By` trailers** on commits or PRs in this repo.
- **When you change a threshold, model, or flag,** update `config.ts`, the docs
  table that references it, and the mirrored web value if one exists. The drift
  catalogued in §4 is what happens otherwise.
- **When you touch liveness, re-read §5 first.** The randomization and the motion
  range are load-bearing.
