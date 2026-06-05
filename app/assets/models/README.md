# Models

The bundled demo ships runnable `.tflite` files here. `metro.config.js` bundles
`*.tflite` as app assets.

| File                  | Purpose             | Input        | Output                  | Source |
|-----------------------|---------------------|--------------|-------------------------|--------|
| `facenet_512.tflite` | recognition (bundled demo) | 160×160×3, mean/std 0.5 | 512-d embedding | github.com/shubham0204/OnDevice-Face-Recognition-Android |
| `edgeface_s.tflite`   | recognition (compact production target) | 112×112×3, mean/std 0.5 | 512-d embedding | github.com/otroshi/edgeface (`edgeface_s_gamma_05.pt` → ONNX → TFLite INT8) |
| `mobilefacenet.tflite`| recognition (compact fallback target) | 112×112×3, mean/std 0.5 | 512-d embedding | ArcFace MobileFaceNet TFLite export |
| `minifasnet.tflite`   | liveness (passive)  | 80×80×3 (2.7× bbox) | 3-class softmax (idx 1 = live) | github.com/shubham0204/OnDevice-Face-Recognition-Android |

## Before coding against a model: verify it in netron

Open each file in https://netron.app and confirm the **input shape, dtype,
normalization, and output length** match `src/config.ts`. A wrong dtype/shape is
the #1 cause of runtime crashes. Update `src/config.ts` — never the worklets.

## Converting EdgeFace (PyTorch → ONNX → TFLite INT8)

```bash
# pip install torch onnx onnx-tf tensorflow
# 1. load edgeface_s_gamma_05.pt, export 1x3x112x112 -> ONNX
# 2. onnx-tf convert -> SavedModel
# 3. TFLiteConverter with INT8 (representative dataset) -> edgeface_s.tflite
```

## Current bundled footprint

- `facenet_512.tflite`: ~45 MB
- `minifasnet.tflite`: ~5.7 MB

This is runnable today but above the original 20 MB target. For the final compact
build, replace `ACTIVE_RECOGNITION` in `app/src/config.ts` with
`edgeface_s` after converting EdgeFace-S to TFLite INT8. Expected compact
footprint: EdgeFace ~1–2 MB, MiniFASNet ~0.6–1.8 MB, TFLite runtime ~5–8 MB.
