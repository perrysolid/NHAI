# Models

The bundled demo ships runnable `.tflite` files here. `metro.config.js` bundles
`*.tflite` as app assets.

| File                  | Purpose             | Input        | Output                  | Source |
|-----------------------|---------------------|--------------|-------------------------|--------|
| `mobilefacenet.tflite` | recognition (bundled compact demo) | 112×112×3, mean/std 0.5 | 192-d embedding | pub.dev/packages/face_detection_tflite |
| `edgeface_s.tflite`   | recognition (compact production target) | 112×112×3, mean/std 0.5 | 512-d embedding | github.com/otroshi/edgeface (`edgeface_s_gamma_05.pt` → ONNX → TFLite INT8) |
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

- `mobilefacenet.tflite`: ~5.0 MB
- `minifasnet.tflite`: ~5.7 MB

This keeps the bundled model assets around 10.7 MB. For the final lowest-footprint
build, replace `ACTIVE_RECOGNITION` in `app/src/config.ts` with `edgeface_s`
after converting EdgeFace-S to TFLite INT8.

FaceNet-512 was tested as a runnable recognition option but is not bundled here
because its approximate 45 MB footprint misses the original compact model
target.
