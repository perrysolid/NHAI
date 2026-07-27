import {preprocessRgb} from '../engine';
import {RECOGNITION_MODELS, LIVENESS_MODEL, ACTIVE_RECOGNITION} from '../../config';

const REC = RECOGNITION_MODELS[ACTIVE_RECOGNITION]; // 112x112x3 float32, mean/std 0.5
const PIXELS = REC.inputSize * REC.inputSize; // 12544
const RGB_BYTES = PIXELS * REC.channels; // 37632

describe('preprocessRgb', () => {
  it('accepts a tightly-packed RGB buffer (the exact expected size)', () => {
    const rgb = new Uint8Array(RGB_BYTES).fill(128);
    const out = preprocessRgb(rgb, REC) as Float32Array;
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(RGB_BYTES);
    // (128/255 - 0.5) / 0.5 ≈ 0.00392
    expect(out[0]).toBeCloseTo((128 / 255 - 0.5) / 0.5, 5);
  });

  it('repacks an RGBA buffer to RGB instead of throwing the 37632 error', () => {
    // This is the real-device failure: the resize plugin returns 4 channels.
    const rgba = new Uint8Array(PIXELS * 4);
    for (let p = 0; p < PIXELS; p++) {
      rgba[p * 4] = 10; // R
      rgba[p * 4 + 1] = 20; // G
      rgba[p * 4 + 2] = 30; // B
      rgba[p * 4 + 3] = 255; // A (must be dropped)
    }
    const out = preprocessRgb(rgba, REC) as Float32Array;
    expect(out.length).toBe(RGB_BYTES);
    expect(out[0]).toBeCloseTo((10 / 255 - 0.5) / 0.5, 5);
    expect(out[1]).toBeCloseTo((20 / 255 - 0.5) / 0.5, 5);
    expect(out[2]).toBeCloseTo((30 / 255 - 0.5) / 0.5, 5);
    // Second pixel must read the next RGB triple, not stale alpha.
    expect(out[3]).toBeCloseTo((10 / 255 - 0.5) / 0.5, 5);
  });

  it('repacks RGBA for the uint8 liveness path too', () => {
    const livePixels = LIVENESS_MODEL.inputSize * LIVENESS_MODEL.inputSize;
    const rgba = new Uint8Array(livePixels * 4);
    for (let p = 0; p < livePixels; p++) {
      rgba[p * 4] = 1;
      rgba[p * 4 + 1] = 2;
      rgba[p * 4 + 2] = 3;
      rgba[p * 4 + 3] = 4;
    }
    const out = preprocessRgb(rgba, LIVENESS_MODEL);
    // float32 path (LIVENESS dtype is float32) of length 80*80*3
    expect(out.length).toBe(livePixels * 3);
  });

  it('still throws when the buffer is not a whole-pixel multiple', () => {
    const bogus = new Uint8Array(RGB_BYTES + 1);
    expect(() => preprocessRgb(bogus, REC)).toThrow(/RGB bytes/);
  });
});
