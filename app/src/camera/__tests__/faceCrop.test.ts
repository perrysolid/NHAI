import {cropFace, scaleBox} from '../faceCrop';

/** Build a width x height RGB buffer from a (x,y,channel)->value function. */
function makeBuffer(
  width: number,
  height: number,
  fn: (x: number, y: number, c: number) => number,
): Uint8Array {
  const buf = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * 3;
      buf[base] = fn(x, y, 0);
      buf[base + 1] = fn(x, y, 1);
      buf[base + 2] = fn(x, y, 2);
    }
  }
  return buf;
}

describe('scaleBox', () => {
  it('scales a frame-space box into downscaled-buffer space', () => {
    const scaled = scaleBox({x: 100, y: 50, width: 200, height: 200}, 0.25);
    expect(scaled).toEqual({x: 25, y: 12.5, width: 50, height: 50});
  });
});

describe('cropFace', () => {
  it('produces a tightly-packed RGB buffer of the requested size', () => {
    const width = 64;
    const height = 64;
    const rgb = makeBuffer(width, height, () => 128);
    const out = cropFace({
      rgb,
      width,
      height,
      box: {x: 16, y: 16, width: 32, height: 32},
      expansion: 1.25,
      targetSize: 112,
    });
    expect(out.length).toBe(112 * 112 * 3);
    expect(out[0]).toBe(128);
  });

  it('samples the face region, not the frame corners (a solid box on noisy bg)', () => {
    const width = 100;
    const height = 100;
    // Background = 0, a solid 255 square where the face is.
    const box = {x: 40, y: 40, width: 20, height: 20};
    const rgb = makeBuffer(width, height, (x, y) => {
      const inFace =
        x >= box.x &&
        x < box.x + box.width &&
        y >= box.y &&
        y < box.y + box.height;
      return inFace ? 255 : 0;
    });
    const out = cropFace({
      rgb,
      width,
      height,
      box,
      expansion: 1.0,
      targetSize: 8,
    });
    // With expansion 1.0 the crop is exactly the face box, so the centre pixel
    // must come from the bright face, not the dark background.
    const centre = out[(4 * 8 + 4) * 3];
    expect(centre).toBeGreaterThan(200);
  });

  it('edge-clamps a face box that runs past the frame edge instead of failing', () => {
    const width = 40;
    const height = 40;
    const rgb = makeBuffer(width, height, () => 90);
    expect(() =>
      cropFace({
        rgb,
        width,
        height,
        // box near the corner; expansion pushes the crop past the buffer.
        box: {x: 30, y: 30, width: 20, height: 20},
        expansion: 2.7,
        targetSize: 80,
      }),
    ).not.toThrow();
  });

  it('reproduces a horizontal gradient it crops from', () => {
    const width = 50;
    const height = 10;
    // Horizontal gradient 0..245.
    const rgb = makeBuffer(width, height, x => Math.min(255, x * 5));
    const out = cropFace({
      rgb,
      width,
      height,
      box: {x: 0, y: 0, width: 50, height: 10},
      expansion: 1.0,
      targetSize: 50,
    });
    // Left edge dark, right edge bright.
    expect(out[0]).toBeLessThan(20);
    expect(out[(0 * 50 + 49) * 3]).toBeGreaterThan(220);
  });

  it('throws on an undersized buffer', () => {
    expect(() =>
      cropFace({
        rgb: new Uint8Array(10),
        width: 20,
        height: 20,
        box: {x: 0, y: 0, width: 5, height: 5},
        expansion: 1.2,
        targetSize: 8,
      }),
    ).toThrow(/buffer too small/);
  });
});
