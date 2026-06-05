/**
 * loader — load @vladmandic/face-api models (served from /models) once, and
 * make sure a TF.js backend is ready.
 */
import * as faceapi from '@vladmandic/face-api';

let loadPromise: Promise<void> | null = null;

/** Minimal view over the bundled TF.js needed to pick + init a backend.
 *  (face-api re-exports tfjs as `tf` but its bundled types omit these.) */
interface TfBackend {
  setBackend: (name: string) => Promise<boolean>;
  ready: () => Promise<void>;
  getBackend: () => string;
}

export function loadModels(baseUrl = '/models'): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      // Explicitly initialize a TF.js backend. Headless / WebGL-less browsers
      // must fall back to CPU, otherwise inference throws "backend not yet
      // initialized". Real browsers get the fast WebGL backend.
      const tf = faceapi.tf as unknown as TfBackend;
      let ok: boolean;
      try {
        ok = await tf.setBackend('webgl');
      } catch {
        ok = false;
      }
      if (!ok) {
        await tf.setBackend('cpu');
      }
      await tf.ready();

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(baseUrl),
        faceapi.nets.faceLandmark68Net.loadFromUri(baseUrl),
        faceapi.nets.faceRecognitionNet.loadFromUri(baseUrl),
        faceapi.nets.faceExpressionNet.loadFromUri(baseUrl),
      ]);
    })();
  }
  return loadPromise;
}

export function isLoaded(): boolean {
  return (
    faceapi.nets.tinyFaceDetector.isLoaded &&
    faceapi.nets.faceLandmark68Net.isLoaded &&
    faceapi.nets.faceRecognitionNet.isLoaded &&
    faceapi.nets.faceExpressionNet.isLoaded
  );
}
