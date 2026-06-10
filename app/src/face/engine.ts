import {
  ACTIVE_RECOGNITION,
  LIVENESS_MODEL,
  RECOGNITION_MODELS,
  type RecognitionSpec,
  type RecognitionModelId,
} from '../config';
import {l2Normalize, type Embedding} from './math';
import {LIVENESS_ASSET, RECOGNITION_ASSETS} from './modelAssets';

import {
  loadTensorflowModel,
  type TensorflowModel,
  type TensorflowModelDelegate,
} from 'react-native-fast-tflite';

export type TensorInput = Float32Array | Uint8Array;

export interface FaceEngine {
  readonly recognitionModel: RecognitionModelId;
  readonly embeddingLength: number;
  load(): Promise<void>;
  embedFace(input: TensorInput): Promise<Embedding>;
  scoreLive(input: TensorInput): Promise<number>;
}

export interface ModelManifest {
  recognition: (typeof RECOGNITION_MODELS)[RecognitionModelId];
  liveness: typeof LIVENESS_MODEL;
}

export function getModelManifest(
  model: RecognitionModelId = ACTIVE_RECOGNITION,
): ModelManifest {
  return {recognition: RECOGNITION_MODELS[model], liveness: LIVENESS_MODEL};
}

export interface TfliteFaceEngineOptions {
  recognitionModel?: RecognitionModelId;
  delegate?: TensorflowModelDelegate;
}

export class TfliteFaceEngine implements FaceEngine {
  readonly recognitionModel: RecognitionModelId;
  readonly embeddingLength: number;

  private recognition?: TensorflowModel;
  private liveness?: TensorflowModel;
  private delegate: TensorflowModelDelegate;

  constructor(options: TfliteFaceEngineOptions = {}) {
    this.recognitionModel = options.recognitionModel ?? ACTIVE_RECOGNITION;
    this.embeddingLength =
      RECOGNITION_MODELS[this.recognitionModel].embeddingLength;
    this.delegate = options.delegate ?? 'default';
  }

  async load(): Promise<void> {
    const recognitionAsset = RECOGNITION_ASSETS[this.recognitionModel];
    if (!recognitionAsset) {
      throw new Error(
        `No bundled TFLite asset for ${
          this.recognitionModel
        }. Convert/download ${
          RECOGNITION_MODELS[this.recognitionModel].assetName
        } first.`,
      );
    }
    const [recognition, liveness] = await Promise.all([
      loadTensorflowModel(recognitionAsset, this.delegate),
      loadTensorflowModel(LIVENESS_ASSET, this.delegate),
    ]);
    this.recognition = recognition;
    this.liveness = liveness;
    this.assertModelShapes();
  }

  async embedFace(input: TensorInput): Promise<Embedding> {
    const model = this.requireRecognition();
    const [output] = await model.run([input]);
    if (!output || output.length !== this.embeddingLength) {
      throw new Error(
        `Recognition output length ${output?.length ?? 0} did not match ${
          this.embeddingLength
        }`,
      );
    }
    return l2Normalize(asNumberArray(output));
  }

  async scoreLive(input: TensorInput): Promise<number> {
    const model = this.requireLiveness();
    const [output] = await model.run([input]);
    if (!output || output.length <= LIVENESS_MODEL.liveClassIndex) {
      throw new Error('Liveness model returned an invalid output tensor');
    }
    return probabilityAt(asNumberArray(output), LIVENESS_MODEL.liveClassIndex);
  }

  private requireRecognition(): TensorflowModel {
    if (!this.recognition) {
      throw new Error('FaceEngine not loaded. Call load() first.');
    }
    return this.recognition;
  }

  private requireLiveness(): TensorflowModel {
    if (!this.liveness) {
      throw new Error('FaceEngine not loaded. Call load() first.');
    }
    return this.liveness;
  }

  private assertModelShapes(): void {
    const recognition = this.requireRecognition();
    const expected = RECOGNITION_MODELS[this.recognitionModel];
    const input = recognition.inputs[0];
    if (input) {
      const flattened = product(input.shape.filter(n => n > 0));
      const expectedFlat =
        expected.inputSize * expected.inputSize * expected.channels;
      if (flattened !== expectedFlat) {
        throw new Error(
          `Recognition input shape ${input.shape.join('x')} does not match ${
            expected.assetName
          } config`,
        );
      }
    }
  }
}

export function preprocessRgb(
  rgb: Uint8Array,
  spec: RecognitionSpec | typeof LIVENESS_MODEL,
): TensorInput {
  const pixels = spec.inputSize * spec.inputSize;
  const expected = pixels * spec.channels;
  // The native resize plugin can hand back RGBA (or another channel count)
  // depending on the device's camera frame format. Repack to tightly-packed RGB
  // instead of hard-failing — that mismatch is what produced the
  // "Expected 37632 RGB bytes, got N" capture failures on real phones.
  let src = rgb;
  if (rgb.length !== expected) {
    if (rgb.length % pixels !== 0 || rgb.length / pixels < spec.channels) {
      throw new Error(`Expected ${expected} RGB bytes, got ${rgb.length}`);
    }
    const channels = rgb.length / pixels;
    const packed = new Uint8Array(expected);
    for (let p = 0; p < pixels; p++) {
      packed[p * 3] = rgb[p * channels];
      packed[p * 3 + 1] = rgb[p * channels + 1];
      packed[p * 3 + 2] = rgb[p * channels + 2];
    }
    src = packed;
  }
  if (spec.dtype === 'uint8') {
    return src;
  }
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i += 3) {
    out[i] = src[i] / 255 / spec.std[0] - spec.mean[0] / spec.std[0];
    out[i + 1] = src[i + 1] / 255 / spec.std[1] - spec.mean[1] / spec.std[1];
    out[i + 2] = src[i + 2] / 255 / spec.std[2] - spec.mean[2] / spec.std[2];
  }
  return out;
}

/**
 * Deterministic engine used only while the real TFLite files are absent. It lets
 * enrollment, matching, liveness, queueing, sync, and benchmarks run locally
 * without pretending that a real model has been loaded.
 */
export class MockFaceEngine implements FaceEngine {
  readonly recognitionModel: RecognitionModelId;
  readonly embeddingLength: number;

  constructor(model: RecognitionModelId = ACTIVE_RECOGNITION) {
    this.recognitionModel = model;
    this.embeddingLength = RECOGNITION_MODELS[model].embeddingLength;
  }

  async load(): Promise<void> {}

  async embedFace(input: TensorInput): Promise<Embedding> {
    let seed = 2166136261;
    const stride = Math.max(1, Math.floor(input.length / 1024));
    for (let i = 0; i < input.length; i += stride) {
      seed = (seed * 16777619 + input[i] + i) % 4294967291;
    }
    const out = new Float32Array(this.embeddingLength);
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 1664525 + 1013904223 + i) % 4294967291;
      out[i] = (seed / 4294967291) * 2 - 1;
    }
    return l2Normalize(out);
  }

  async scoreLive(input: TensorInput): Promise<number> {
    if (input.length === 0) {
      return 0;
    }
    let sum = 0;
    const stride = Math.max(1, Math.floor(input.length / 512));
    let n = 0;
    for (let i = 0; i < input.length; i += stride) {
      sum += input[i];
      n++;
    }
    const mean = sum / Math.max(1, n);
    return Math.max(0, Math.min(1, mean / 255));
  }
}

export class MissingModelFaceEngine implements FaceEngine {
  readonly recognitionModel: RecognitionModelId;
  readonly embeddingLength: number;

  constructor(model: RecognitionModelId = ACTIVE_RECOGNITION) {
    this.recognitionModel = model;
    this.embeddingLength = RECOGNITION_MODELS[model].embeddingLength;
  }

  async load(): Promise<void> {
    const manifest = getModelManifest(this.recognitionModel);
    throw new Error(
      `TFLite assets not bundled yet: ${manifest.recognition.assetName}, ${manifest.liveness.assetName}`,
    );
  }

  async embedFace(): Promise<Embedding> {
    await this.load();
    throw new Error('unreachable');
  }

  async scoreLive(): Promise<number> {
    await this.load();
    throw new Error('unreachable');
  }
}

function product(values: number[]): number {
  return values.reduce((acc, value) => acc * value, 1);
}

function probabilityAt(values: ArrayLike<number>, index: number): number {
  const sum = Array.from(values).reduce((acc, value) => acc + value, 0);
  if (sum > 0.99 && sum < 1.01) {
    return values[index];
  }
  const exps = Array.from(values, value => Math.exp(value));
  const denom = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps[index] / denom;
}

function asNumberArray(values: ArrayLike<unknown>): ArrayLike<number> {
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] !== 'number') {
      throw new Error('Model output must be a numeric typed array');
    }
  }
  return values as ArrayLike<number>;
}
