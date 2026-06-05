# Models

Drop the quantized `.tflite` model files here. They are **not** committed to git
(they're downloaded from the open-source sources below). `metro.config.js`
bundles `*.tflite` as assets.

| File                  | Purpose             | Input        | Output                  | Source |
|-----------------------|---------------------|--------------|-------------------------|--------|
| `edgeface_s.tflite`   | recognition (primary) | 112×112×3, mean/std 0.5 | 512-d embedding | github.com/otroshi/edgeface (`edgeface_s_gamma_05.pt` → ONNX → TFLite INT8) |
| `mobilefacenet.tflite`| recognition (fallback) | 112×112×3, mean/std 0.5 | 512-d embedding | ArcFace MobileFaceNet TFLite export |
| `minifasnet.tflite`   | liveness (passive)  | 80×80×3 (2.7× bbox) | 3-class softmax (idx 1 = live) | github.com/minivision-ai/Silent-Face-Anti-Spoofing |

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

Expected footprint: EdgeFace ~1–2 MB, MiniFASNet ~0.6–1.8 MB, TFLite runtime
~5–8 MB → well under the 20 MB budget.
