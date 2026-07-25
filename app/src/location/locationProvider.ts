/**
 * locationProvider — the only place that touches the native GPS module. Kept
 * behind a small interface so the pipeline depends on `LocationProvider`, not on
 * react-native-geolocation-service directly (which also keeps unit tests clean).
 *
 * The native fix carries a `mocked` flag (Android API >= 18, iOS >= 15) set when
 * the OS sees a mock/fake-GPS provider — that's the primary spoof signal. It is
 * not bulletproof (rooted phones can hide it), so the backend does a second
 * impossible-speed / trajectory check on sync.
 */
import {PermissionsAndroid, Platform} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import type {LocationFix} from './types';

export interface GetFixOptions {
  timeoutMs: number;
  maxAgeMs: number;
}

export interface LocationProvider {
  requestPermission(): Promise<boolean>;
  getFix(opts: GetFixOptions): Promise<LocationFix | null>;
}

export class NativeLocationProvider implements LocationProvider {
  async requestPermission(): Promise<boolean> {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
      const status = await Geolocation.requestAuthorization('whenInUse');
      return status === 'granted';
    } catch {
      return false;
    }
  }

  getFix(opts: GetFixOptions): Promise<LocationFix | null> {
    return new Promise(resolve => {
      try {
        Geolocation.getCurrentPosition(
          position => {
            resolve({
              lat: position.coords.latitude,
              lon: position.coords.longitude,
              accuracyM: position.coords.accuracy ?? Number.POSITIVE_INFINITY,
              // `mocked` is present on Android and iOS >= 15; treat missing as false.
              mocked: (position as {mocked?: boolean}).mocked === true,
              timestamp: position.timestamp,
            });
          },
          () => resolve(null),
          {
            enableHighAccuracy: true,
            timeout: opts.timeoutMs,
            maximumAge: opts.maxAgeMs,
          },
        );
      } catch {
        resolve(null);
      }
    });
  }
}

/** Deterministic provider for tests / non-native surfaces. */
export class StubLocationProvider implements LocationProvider {
  constructor(private fix: LocationFix | null = null) {}
  async requestPermission(): Promise<boolean> {
    return this.fix !== null;
  }
  async getFix(): Promise<LocationFix | null> {
    return this.fix;
  }
}

export function createLocationProvider(): LocationProvider {
  return new NativeLocationProvider();
}
