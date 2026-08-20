# Models

The bundled app ships runnable `.tflite` files here. `metro.config.js` bundles
`*.tflite` as app assets.

Note these files are **gitignored by extension** (`*.tflite`) with
`app/assets/models/*.tflite` as a deliberate exception — so they *are* tracked.
Check `git status` before assuming otherwise.

## Bundled assets

| File | Purpose | Input | Output | Size | Source |
|------|---------|-------|--------|------|--------|
| `edgeface_s.tflite` | recognition — **active** | 112×112×3 RGB, `(px/255 − 0.5)/0.5` | 512-d, L2-normalized | **14.2 MB** (float32) | [otroshi/edgeface](https://github.com/otroshi/edgeface) (`edgeface_s_gamma_05.pt` → ONNX → TFLite) |
| `minifasnet.tflite` | liveness (passive) | 80×80×3 **BGR**, 2.7× bbox crop, **raw 0–255** | 3-class softmax (**idx 1 = live**) | **5.7 MB** | [shubham0204/OnDevice-Face-Recognition-Android](https://github.com/shubham0204/OnDevice-Face-Recognition-Android) |

**Total bundled footprint: 19.9 MB** — inside the 20 MB brief, with little
headroom.

`ACTIVE_RECOGNITION = 'edgeface_s'` in `app/src/config.ts`. MobileFaceNet exists
in config as a **spec placeholder with no bundled asset** — `RECOGNITION_ASSETS`
maps only `edgeface_s`, so selecting `mobilefacenet` throws at
`TfliteFaceEngine.load()`.

FaceNet-512 was tested as a recognition option but is not bundled: at ~45 MB it
misses the compact-model target outright.

## EdgeFace-S ships float32, not INT8 — deliberately

Earlier revisions of this file described EdgeFace-S as INT8 (~1–2 MB). It is
**float32**. Commit `400102a` switched away from INT8 on purpose: *"switch to
Float32 EdgeFace-S for accurate face matching."* The ~13 MB is the price of
reliable matching.

Re-quantising to **float16 (~3.5 MB)** is the documented next step and the main
headroom lever — see `finetune/README.md`.

## MiniFASNet expects raw 0–255 — this is not a typo

`LIVENESS_MODEL.std` is `[1/255, 1/255, 1/255]`, which makes `preprocessRgb`
emit **raw pixel values**. That looks wrong and is not: the model traces to
Minivision's Silent-Face, whose `ToTensor` has the `.div(255)` line commented
out. It was trained on 0–255.

Feeding it 0–1 made every activation 255× too small and the model emitted a
near-constant score (~0.007 for *any* input), which is why no threshold ever
worked. `channelOrder: 'bgr'` and `liveClassIndex: 1` are correct — don't
re-suspect them.

## Before coding against a model: verify it in netron

Open each file in [netron.app](https://netron.app) and confirm the **input shape,
dtype, normalization, and output length** match `src/config.ts`. A wrong
dtype/shape is the #1 cause of runtime crashes.

Update `src/config.ts` — **never** hardcode a shape or constant in a worklet.

## Converting EdgeFace (PyTorch → ONNX → TFLite)

```bash
# pip install torch onnx onnx-tf tensorflow
# 1. load edgeface_s_gamma_05.pt, export 1x3x112x112 -> ONNX
# 2. onnx-tf convert -> SavedModel
# 3. TFLiteConverter -> edgeface_s.tflite
#    float32 (current) or float16 (the documented next step).
#    INT8 needs a representative dataset and cost accuracy here.
```

**Any re-quantisation forces re-enrollment.** Templates are not portable across
models — embeddings whose dimension does not match the active model are filtered
out at load, so users would see "no enrollments". Update `RecognitionSpec.dtype`
and plan the migration.
