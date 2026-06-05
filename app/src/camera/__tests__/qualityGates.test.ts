import {evaluateFace} from '../qualityGates';
import type {Face} from '../types';

const FRAME_W = 1000;

function makeFace(overrides: Partial<Face> = {}): Face {
  return {
    bounds: {x: 100, y: 100, width: 400, height: 500}, // ratio 0.4 (>0.2)
    yawAngle: 0,
    pitchAngle: 0,
    rollAngle: 0,
    smilingProbability: 0,
    leftEyeOpenProbability: 1,
    rightEyeOpenProbability: 1,
    ...overrides,
  };
}

const goodBrightness = 140;

describe('evaluateFace quality gates', () => {
  it('flags no face', () => {
    const r = evaluateFace({faces: [], frameWidth: FRAME_W, brightness: 140});
    expect(r.status).toBe('no_face');
    expect(r.ready).toBe(false);
  });

  it('flags multiple faces', () => {
    const r = evaluateFace({
      faces: [makeFace(), makeFace()],
      frameWidth: FRAME_W,
      brightness: goodBrightness,
    });
    expect(r.status).toBe('multiple_faces');
  });

  it('flags a face that is too far (small)', () => {
    const r = evaluateFace({
      faces: [makeFace({bounds: {x: 0, y: 0, width: 80, height: 100}})], // 0.08 < minFaceRatio
      frameWidth: FRAME_W,
      brightness: goodBrightness,
    });
    expect(r.status).toBe('too_far');
  });

  it('flags off-angle pose (yaw)', () => {
    const r = evaluateFace({
      faces: [makeFace({yawAngle: 45})],
      frameWidth: FRAME_W,
      brightness: goodBrightness,
    });
    expect(r.status).toBe('off_angle');
  });

  it('flags off-angle pose (pitch)', () => {
    const r = evaluateFace({
      faces: [makeFace({pitchAngle: -40})],
      frameWidth: FRAME_W,
      brightness: goodBrightness,
    });
    expect(r.status).toBe('off_angle');
  });

  it('flags too dark', () => {
    const r = evaluateFace({
      faces: [makeFace()],
      frameWidth: FRAME_W,
      brightness: 20,
    });
    expect(r.status).toBe('too_dark');
  });

  it('flags too bright', () => {
    const r = evaluateFace({
      faces: [makeFace()],
      frameWidth: FRAME_W,
      brightness: 250,
    });
    expect(r.status).toBe('too_bright');
  });

  it('passes a well-framed, frontal, well-lit single face', () => {
    const r = evaluateFace({
      faces: [makeFace()],
      frameWidth: FRAME_W,
      brightness: goodBrightness,
    });
    expect(r.status).toBe('ok');
    expect(r.ready).toBe(true);
  });
});
