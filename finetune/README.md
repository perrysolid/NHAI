# EdgeFace-S → Indian-face fine-tune → TFLite

`EdgeFace_IndicFairFace_finetune.ipynb` fine-tunes the SOTA compact backbone
**EdgeFace-S** on Indian faces with **ArcFace**, quantifies demographic robustness
on **IndicFairFace**, and exports a **float16 TFLite** model that drops into the
offline app (`app/assets/models/edgeface_s.tflite`).

## Why these choices
- **EdgeFace-S** — IJCB-2023 efficient-FR winner, 1.77 M params, 512-d, 99.73% LFW.
  Official weights via `torch.hub('otroshi/edgeface', 'edgeface_s_gamma_05')`.
- **IMFDB** for training — the Indian Movie Face Database is *identity-labelled*
  (34,512 images, 100 identities), which ArcFace requires. IndicFairFace is a
  bias-measurement set (balanced by state), so it's used for **evaluation**, not
  training.
- **float16 TFLite, not INT8** — the app feeds the model *normalised float* input
  (`config.ts` dtype `float32`, mean/std 0.5). INT8 with uint8 I/O would require
  rewriting the app's preprocessing; float16 (~3.5 MB) drops in unchanged.

## Data layout
```
data/indian_faces_raw/<identity>/*.jpg          # IMFDB (or any labelled set), unaligned
data/indian_faces_val_aligned/<identity>/*.jpg  # optional held-out identities (honest metric)
data/indicfairface_aligned/<state>/<identity>/*.jpg   # optional, for the bias number
```
The notebook's step 3 aligns raw → 112×112 with MTCNN automatically.

## Get the datasets
- **IMFDB:** https://cvit.iiit.ac.in/projects/IMFDB/ (request access; per-actor folders).
- **IndicFairFace:** arXiv 2602.12659 — balanced Indian set, grouped by state.

## Run
Open in Jupyter on the GPU box, run top to bottom. Every risky step has a sanity
assert (embedding dim, aligned shape, TFLite↔PyTorch cosine > 0.999) so failures
surface immediately. Expect minutes per epoch on a 40 GB GPU.

## Drop the result into the app
See the final notebook cell: copy `outputs/edgeface_s.tflite` into
`app/assets/models/`, register it in `app/src/face/modelAssets.ts`, set
`ACTIVE_RECOGNITION = 'edgeface_s'` in `app/src/config.ts`, verify I/O in Netron,
and re-enroll (512-d templates differ from MobileFaceNet's 192-d).
