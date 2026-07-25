/**
 * Location / geofencing types.
 *
 * A geofence answers "is the worker physically at the assigned site?" — the one
 * thing face + liveness cannot prove. Everything here is evaluated ON-DEVICE
 * against locally-provisioned site coordinates, so it works with zero network
 * (GPS is satellite-based). Only the resulting scalar summary is synced.
 */

export interface LatLon {
  /** WGS-84 latitude in decimal degrees. */
  lat: number;
  /** WGS-84 longitude in decimal degrees. */
  lon: number;
}

/** A single GPS reading from the device. */
export interface LocationFix extends LatLon {
  /** Horizontal accuracy radius in metres (smaller = better). */
  accuracyM: number;
  /** True when the OS reports the fix came from a mock/fake-GPS provider. */
  mocked: boolean;
  /** Epoch ms of the fix. */
  timestamp: number;
}

/**
 * The shape of an assigned site. A circle is the common case (a point + radius);
 * a polygon captures a highway chainage stretch or an irregular yard boundary.
 */
export type SiteShape =
  | {kind: 'circle'; center: LatLon; radiusM: number}
  | {kind: 'polygon'; polygon: LatLon[]};

export interface Site {
  id: string;
  name: string;
  shape: SiteShape;
}

export type GeofenceReason =
  | 'inside'
  | 'outside'
  | 'poor_accuracy'
  | 'mocked'
  | 'no_fix'
  | 'no_sites';

export interface GeofenceResult {
  /** Overall: inside a site AND accuracy acceptable AND not a rejected mock. */
  passed: boolean;
  /** Nearest site (present whenever sites exist and a fix is available). */
  siteId?: string;
  siteName?: string;
  /** Whether the fix falls within the nearest site's boundary. */
  insideSite: boolean;
  /** Metres outside the boundary (0 when inside). */
  distanceM: number;
  /** Whether horizontal accuracy met the configured ceiling. */
  accuracyOk: boolean;
  /** True when a mock fix was rejected by policy. */
  mockRejected: boolean;
  reason: GeofenceReason;
}

export interface GeofenceOptions {
  /** Reject fixes whose accuracy radius exceeds this (metres). */
  maxAccuracyM: number;
  /** When true, a mock-provider fix fails the geofence outright. */
  rejectMocked: boolean;
}
