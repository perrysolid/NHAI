/**
 * CameraScreen — Phase 2.
 *
 * Front-camera preview + on-device face detection and quality gates. A frame
 * processor (throttled to CAMERA.targetFps) runs ML Kit face detection and a
 * cheap brightness probe on the worklet thread, hands the result to JS via
 * createRunOnJS, and the JS side computes the gate + guidance.
 *
 * Still no recognition/liveness inference here — that's Phase 3+. 100% offline.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import {
  useFaceDetector,
  type FaceDetectionOptions,
} from 'react-native-vision-camera-face-detector';
import {useResizePlugin} from 'vision-camera-resize-plugin';
import {Worklets} from 'react-native-worklets-core';

import {CAMERA} from '../config';
import {evaluateFace} from '../camera/qualityGates';
import {meanLuma} from '../camera/frameUtils';
import type {Face, GateResult} from '../camera/types';
import GuidanceOverlay from './GuidanceOverlay';

const INITIAL_GATE: GateResult = {
  status: 'no_face',
  guidance: 'Center your face in the circle',
  ready: false,
};

export default function CameraScreen(): React.JSX.Element {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('front');
  const [gate, setGate] = useState<GateResult>(INITIAL_GATE);

  const faceOptions = useMemo<FaceDetectionOptions>(
    () => ({
      performanceMode: 'fast',
      landmarkMode: 'none',
      contourMode: 'none',
      // 'all' gives smiling/eye-open probabilities, needed for Phase 4 liveness.
      classificationMode: 'all',
      trackingEnabled: true,
    }),
    [],
  );

  const {detectFaces} = useFaceDetector(faceOptions);
  const {resize} = useResizePlugin();

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Worklet -> JS bridge: compute the gate on the JS thread from raw signals.
  const onSignals = useMemo(
    () =>
      Worklets.createRunOnJS(
        (faces: Face[], frameWidth: number, brightness: number) => {
          setGate(evaluateFace({faces, frameWidth, brightness}));
        },
      ),
    [],
  );

  const frameProcessor = useFrameProcessor(
    frame => {
      'worklet';
      runAtTargetFps(CAMERA.targetFps, () => {
        'worklet';
        const faces = detectFaces(frame);
        // Cheap brightness probe: downscale to 16x16 RGB and average luma.
        const small = resize(frame, {
          scale: {width: 16, height: 16},
          pixelFormat: 'rgb',
          dataType: 'uint8',
        });
        const brightness = meanLuma(small as Uint8Array);
        onSignals(faces, frame.width, brightness);
      });
    },
    [detectFaces, resize, onSignals],
  );

  const onRequest = useCallback(() => {
    requestPermission().then(granted => {
      if (!granted) {
        Linking.openSettings();
      }
    });
  }, [requestPermission]);

  if (!hasPermission) {
    return (
      <Centered>
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.subtitle}>
          We verify identity entirely on-device. No images leave your phone.
        </Text>
        <TouchableOpacity style={styles.button} onPress={onRequest}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </TouchableOpacity>
      </Centered>
    );
  }

  if (device == null) {
    return (
      <Centered>
        <ActivityIndicator color="#fff" />
        <Text style={styles.subtitle}>No front camera found…</Text>
      </Centered>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        frameProcessor={frameProcessor}
      />
      <GuidanceOverlay gate={gate} />
      <View style={styles.badge}>
        <Text style={styles.badgeText}>Phase 2 · detect + gates · offline</Text>
      </View>
    </View>
  );
}

function Centered({children}: {children: React.ReactNode}): React.JSX.Element {
  return <View style={[styles.container, styles.centered]}>{children}</View>;
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000'},
  centered: {alignItems: 'center', justifyContent: 'center', padding: 24},
  title: {color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 8},
  subtitle: {
    color: '#bbb',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  button: {
    marginTop: 20,
    backgroundColor: '#2563eb',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: {color: '#fff', fontWeight: '600'},
  badge: {
    position: 'absolute',
    top: 16,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  badgeText: {color: '#fff', fontSize: 12, letterSpacing: 0.3},
});
