import {MMKV} from 'react-native-mmkv';
import {CalibrationRecorder} from '../face/livenessCalibration';
import {OfflineAuthStore, type KeyValueStorage} from './offlineStore';

const MMKV_ID = 'datalake-face-auth';

// SECURITY DEBT: this key is a hardcoded placeholder, identical on every device,
// so templates are not meaningfully encrypted. It must come from the Android
// Keystore / iOS Keychain, generated per device on first run, before any real
// deployment. Tracked in CLAUDE.md §8 as a rollout blocker.
const ENCRYPTION_KEY = 'replace-with-device-keychain-secret';

/**
 * A handle onto the device store. Deliberately constructed per call rather than
 * cached in a module singleton: MMKV keys storage by `id`, so every handle sees
 * the same data on-device, while a fresh handle per call keeps each test's
 * store isolated (the jest mock backs each instance with its own Map).
 */
function openStorage(): KeyValueStorage {
  return new MMKV({id: MMKV_ID, encryptionKey: ENCRYPTION_KEY});
}

export function createEncryptedAuthStore(): OfflineAuthStore {
  return new OfflineAuthStore(openStorage());
}

/** Recorder for liveness deadline calibration (FLAGS.CALIBRATE_LIVENESS). */
export function createCalibrationRecorder(): CalibrationRecorder {
  return new CalibrationRecorder(openStorage());
}
