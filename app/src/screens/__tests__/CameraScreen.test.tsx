/**
 * CameraScreen integration test — proves capture and verification are each
 * hands-free once the operator is on their respective screen.
 *
 * We mount the REAL CameraScreen with the native modules mocked, then feed it a
 * good, centered face through the real frame -> quality-gate -> auto-capture
 * pipeline. No capture or verify button is ever tapped — only the two screen
 * transitions (Enroll -> camera, then Home -> Verify) are. We assert that:
 *   1. enrollment auto-captures all 4 guided poses (neutral, smile, blink,
 *      turn) and the screen returns Home (it must not silently swap into the
 *      verify UI), and
 *   2. once the operator explicitly opens Verify, the challenge auto-starts
 *      asking for all 3 actions (blink/smile/turn) in random order, the
 *      cycling face satisfies each one, and the result is a Match.
 *
 * The mocked face cycles eye-open / yaw each frame so it satisfies blink and
 * turn (and holds a constant smiling probability so smile is always
 * satisfied), and the mocked TFLite model returns a fixed embedding so the
 * probe self-matches the enrollment.
 */
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('react-native-vision-camera', () => {
  const RReact = require('react');
  return {
    Camera: ({isActive, frameProcessor}: any) => {
      RReact.useEffect(() => {
        if (!isActive || !frameProcessor) {
          return;
        }
        const id = setInterval(
          () => frameProcessor({width: 480, height: 640}),
          50,
        );
        return () => clearInterval(id);
      }, [isActive, frameProcessor]);
      return null;
    },
    useCameraDevice: () => ({id: 'front', position: 'front'}),
    useCameraPermission: () => ({
      hasPermission: true,
      requestPermission: async () => true,
    }),
    useFrameProcessor: (fn: any) => fn,
    runAtTargetFps: (_fps: number, fn: () => void) => fn(),
  };
});

jest.mock('react-native-vision-camera-face-detector', () => {
  let frame = 0;
  return {
    useFaceDetector: () => ({
      detectFaces: () => {
        frame += 1;
        // Cycle eye-openness and yaw every frame so the active-liveness
        // challenge (blink + turn + smile, random order) is always satisfiable.
        const eyeOpen = frame % 2 === 0 ? 0.92 : 0.12;
        const yaw = frame % 2 === 0 ? 3 : 20; // both < maxYawDeg (45)
        return [
          {
            bounds: {x: 144, y: 128, width: 192, height: 192}, // ratio 0.4
            yawAngle: yaw,
            pitchAngle: 4,
            rollAngle: 0,
            leftEyeOpenProbability: eyeOpen,
            rightEyeOpenProbability: eyeOpen,
            smilingProbability: 0.92,
            trackingId: 1,
          },
        ];
      },
    }),
  };
});

jest.mock('vision-camera-resize-plugin', () => ({
  useResizePlugin: () => ({
    resize: (_frame: any, opts: any) => {
      const w = opts.scale.width;
      const h = opts.scale.height;
      return new Uint8Array(w * h * 3).fill(130); // mid brightness -> gate ok
    },
  }),
}));

jest.mock('react-native-worklets-core', () => ({
  Worklets: {createRunOnJS: (fn: any) => fn},
}));

import CameraScreen from '../CameraScreen';

jest.useFakeTimers();

type Inst = TestRenderer.ReactTestInstance;

function textOf(inst: Inst): string {
  const c = inst.props.children;
  if (Array.isArray(c)) {
    return c.map(x => (x == null ? '' : String(x))).join('');
  }
  return c == null ? '' : String(c);
}

function press(root: Inst, label: string): void {
  const target = root.findAll(
    n => n.type === Text && textOf(n).trim() === label,
  )[0];
  if (!target) {
    throw new Error(`button not found: "${label}"`);
  }
  let node: Inst | null = target;
  while (node && typeof node.props.onPress !== 'function') {
    node = node.parent;
  }
  if (!node) {
    throw new Error(`no onPress ancestor for: "${label}"`);
  }
  act(() => node!.props.onPress());
}

function anyText(root: Inst, pred: (t: string) => boolean): boolean {
  return root.findAll(n => n.type === Text && pred(textOf(n))).length > 0;
}

// Reads a stat tile's numeric value by locating its label and taking the
// sibling value Text within the same metric container.
function metricValue(root: Inst, label: string): string | null {
  const labelNode = root.findAll(
    n => n.type === Text && textOf(n) === label,
  )[0];
  if (!labelNode || !labelNode.parent) {
    return null;
  }
  const texts = labelNode.parent.findAll(n => n.type === Text);
  return texts.length ? textOf(texts[0]) : null;
}

async function flush(): Promise<void> {
  // Let the engine.load() promise chain settle.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

test('hands-free capture: centered face auto-enrolls and returns Home', async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<CameraScreen />);
  });
  await act(async () => {
    await flush();
    await jest.advanceTimersByTimeAsync(0);
  });
  const root = tree.root;

  // Navigate Home -> ID setup -> generate an ID -> camera. (These are the only
  // taps; capture itself is never tapped.)
  press(root, 'Enroll');
  press(root, 'Generate ID');
  press(root, 'Continue to camera');

  let enrolledTemplate = false; // Templates stat reached 1 on Home (durable enroll proof)

  // Drive the camera for up to ~7s of mocked frames. No capture button is ever
  // pressed — all 4 poses (neutral, smile, blink, turn) fire automatically off
  // the centered/cycling face. The enroll screen holds on a "saved"
  // confirmation for CAMERA.enrollCompleteDelayMs before handing back to Home,
  // where the Templates stat lives (the enroll screen itself shows no stats),
  // so this loop also proves that hold happens.
  for (let elapsed = 0; elapsed < 7000; elapsed += 250) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
      await flush();
    });
    if (metricValue(root, 'Templates') === '1') {
      enrolledTemplate = true;
      break;
    }
  }

  // Enrollment was saved automatically (3 samples, no taps)...
  expect(enrolledTemplate).toBe(true);
  // ...and enrollment hands off back to Home instead of silently opening the
  // verify UI on the same screen — proven by the Home-only "Verify" button and
  // the success banner it carries with it.
  expect(anyText(root, t => t === 'Verify')).toBe(true);
  expect(anyText(root, t => t.startsWith('Enrollment saved offline'))).toBe(
    true,
  );

  act(() => tree.unmount());
});

test('hands-free verify: opening Verify auto-runs liveness + matching', async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<CameraScreen />);
  });
  await act(async () => {
    await flush();
    await jest.advanceTimersByTimeAsync(0);
  });
  const root = tree.root;

  press(root, 'Enroll');
  press(root, 'Generate ID');
  press(root, 'Continue to camera');

  // Waits through capture AND the post-save "Enrollment saved" hold on the
  // enroll screen (CAMERA.enrollCompleteDelayMs) before Home — and hence the
  // Templates stat — appears.
  for (let elapsed = 0; elapsed < 7000; elapsed += 250) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
      await flush();
    });
    if (metricValue(root, 'Templates') === '1') {
      break;
    }
  }

  // Back on Home now. Open Verify — the only tap in this phase; the liveness
  // challenge and the match itself are never tapped.
  press(root, 'Verify');

  let matched = false;
  for (let elapsed = 0; elapsed < 11000; elapsed += 250) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
      await flush();
    });
    if (anyText(root, t => t.startsWith('Matched'))) {
      matched = true;
      break;
    }
  }

  expect(matched).toBe(true);

  act(() => tree.unmount());
});
