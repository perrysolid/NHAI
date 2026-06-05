import {
  ACTIVE_RECOGNITION,
  LIVENESS_MODEL,
  RECOGNITION_MODELS,
  type RecognitionModelId,
} from '../config';
import {l2Normalize, type Embedding} from './math';

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
