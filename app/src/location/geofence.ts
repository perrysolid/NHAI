/**
 * geofence — pure, offline geospatial math. No network, no native module, so it
 * is fully unit-testable and identical on Android, iOS and web.
 *
 * Circle test:  great-circle (haversine) distance to the centre vs the radius.
 * Polygon test: ray-casting point-in-polygon, with point-to-edge distance (in a
 *               local metre frame) for "how far outside" reporting.
 */
import type {
  GeofenceOptions,
  GeofenceResult,
  LatLon,
  LocationFix,
  Site,
} from './types';

const EARTH_RADIUS_M = 6371008.8; // IUGG mean Earth radius

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Initial bearing (degrees, 0=N, clockwise) from `from` toward `to`. */
export function bearingDeg(from: LatLon, to: LatLon): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Nearest 8-point compass label ('N', 'NE', …) for a bearing in degrees. */
export function compass8(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Great-circle distance between two lat/lon points, in metres. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Project a point to local east/north metres relative to an origin
 * (equirectangular approximation — accurate to well under a metre at the few-km
 * scale of a work site, which is all a geofence needs).
 */
function toLocalMeters(origin: LatLon, p: LatLon): {x: number; y: number} {
  const x =
    toRad(p.lon - origin.lon) * Math.cos(toRad(origin.lat)) * EARTH_RADIUS_M;
  const y = toRad(p.lat - origin.lat) * EARTH_RADIUS_M;
  return {x, y};
}

/** Ray-casting point-in-polygon. Polygon is an ordered ring of lat/lon vertices. */
export function pointInPolygon(point: LatLon, polygon: LatLon[]): boolean {
  if (polygon.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance (metres) from a point to a polygon's edges. */
export function distanceToPolygonMeters(
  point: LatLon,
  polygon: LatLon[],
): number {
  let best = Infinity;
  const p = toLocalMeters(point, point); // {0,0}
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = toLocalMeters(point, polygon[j]);
    const b = toLocalMeters(point, polygon[i]);
    best = Math.min(best, pointSegmentDistance(p, a, b));
  }
  return best === Infinity ? 0 : best;
}

function pointSegmentDistance(
  p: {x: number; y: number},
  a: {x: number; y: number},
  b: {x: number; y: number},
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

interface SiteDistance {
  site: Site;
  insideSite: boolean;
  /** Metres outside the boundary; 0 when inside. */
  distanceM: number;
}

/** Distance of a fix to one site: inside flag + metres outside the boundary. */
export function distanceToSite(fix: LatLon, site: Site): SiteDistance {
  if (site.shape.kind === 'circle') {
    const d = haversineMeters(fix, site.shape.center);
    const inside = d <= site.shape.radiusM;
    return {
      site,
      insideSite: inside,
      distanceM: inside ? 0 : d - site.shape.radiusM,
    };
  }
  const inside = pointInPolygon(fix, site.shape.polygon);
  return {
    site,
    insideSite: inside,
    distanceM: inside ? 0 : distanceToPolygonMeters(fix, site.shape.polygon),
  };
}

/**
 * Evaluate a fix against all provisioned sites. Picks the nearest site and
 * applies the mock and accuracy policies. Pure — the caller supplies the fix.
 */
export function evaluateGeofence(
  fix: LocationFix | null,
  sites: Site[],
  opts: GeofenceOptions,
): GeofenceResult {
  if (!fix) {
    return base('no_fix');
  }
  if (sites.length === 0) {
    return {
      ...base('no_sites'),
      accuracyOk: fix.accuracyM <= opts.maxAccuracyM,
    };
  }

  let nearest = distanceToSite(fix, sites[0]);
  for (let i = 1; i < sites.length; i++) {
    const candidate = distanceToSite(fix, sites[i]);
    // Prefer a site we're inside; otherwise the closest boundary.
    if (
      (candidate.insideSite && !nearest.insideSite) ||
      candidate.distanceM < nearest.distanceM
    ) {
      nearest = candidate;
    }
  }

  const accuracyOk = fix.accuracyM <= opts.maxAccuracyM;
  const mockRejected = opts.rejectMocked && fix.mocked;

  let reason: GeofenceResult['reason'];
  if (mockRejected) {
    reason = 'mocked';
  } else if (!accuracyOk) {
    reason = 'poor_accuracy';
  } else if (nearest.insideSite) {
    reason = 'inside';
  } else {
    reason = 'outside';
  }

  return {
    passed: nearest.insideSite && accuracyOk && !mockRejected,
    siteId: nearest.site.id,
    siteName: nearest.site.name,
    insideSite: nearest.insideSite,
    distanceM: Math.round(nearest.distanceM),
    accuracyOk,
    mockRejected,
    reason,
  };
}

function base(reason: GeofenceResult['reason']): GeofenceResult {
  return {
    passed: false,
    insideSite: false,
    distanceM: 0,
    accuracyOk: false,
    mockRejected: false,
    reason,
  };
}
