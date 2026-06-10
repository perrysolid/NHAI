/**
 * CameraScreen integration test — proves the app is fully hands-free.
 *
 * We mount the REAL CameraScreen with the native modules mocked, then feed it a
 * good, centered face through the real frame -> quality-gate -> auto-capture
 * pipeline (no taps on any capture/verify button). We assert that:
 *   1. enrollment is saved automatically after the configured samples, and
 *   2. verification then auto-starts, the cycling face satisfies active
 *      liveness, and the result is a Match.
 *
 * The mocked face cycles eye-open / yaw each frame so it satisfies blink, smile
 * and turn in whatever random order the challenge picks, and the mocked TFLite
 * model returns a fixed embedding so the probe self-matches the enrollment.
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

test('hands-free: centered face auto-enrolls, then auto-verifies to a match', async () => {
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
  // taps; capture and verify themselves are never tapped.)
  press(root, 'Enroll');
  press(root, 'Generate ID');
  press(root, 'Continue to camera');

  let enrolledTemplate = false; // Templates stat reached 1 (durable enroll proof)
  let matched = false; // a verification auto-completed as a match

  // Drive the camera for ~10s of mocked frames, sampling the UI as we go. No
  // capture/verify button is ever pressed — everything below is automatic.
  for (let elapsed = 0; elapsed < 11000; elapsed += 250) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(250);
      await flush();
    });
    if (metricValue(root, 'Templates') === '1') {
      enrolledTemplate = true;
    }
    if (anyText(root, t => t.startsWith('Matched'))) {
      matched = true;
    }
    if (enrolledTemplate && matched) {
      break;
    }
  }

  // Enrollment was saved automatically (3 samples, no taps)...
  expect(enrolledTemplate).toBe(true);
  // ...then verification auto-started, active liveness passed, and it matched.
  expect(matched).toBe(true);

  act(() => tree.unmount());
});
