import {
  distanceToSite,
  evaluateGeofence,
  haversineMeters,
  pointInPolygon,
} from '../geofence';
import type {GeofenceOptions, LocationFix, Site} from '../types';

const OPTS: GeofenceOptions = {maxAccuracyM: 50, rejectMocked: true};

const SITE_A: Site = {
  id: 'siteA',
  name: 'Chainage 12+400',
  shape: {kind: 'circle', center: {lat: 28.6139, lon: 77.209}, radiusM: 100},
};

function fix(partial: Partial<LocationFix>): LocationFix {
  return {
    lat: 28.6139,
    lon: 77.209,
    accuracyM: 10,
    mocked: false,
    timestamp: 1,
    ...partial,
  };
}

describe('haversineMeters', () => {
  it('is ~0 for the same point', () => {
    expect(haversineMeters({lat: 10, lon: 10}, {lat: 10, lon: 10})).toBeCloseTo(
      0,
      5,
    );
  });

  it('gives ~111 m for 0.001° of latitude', () => {
    const d = haversineMeters({lat: 0, lon: 0}, {lat: 0.001, lon: 0});
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('pointInPolygon', () => {
  const square = [
    {lat: 0, lon: 0},
    {lat: 0, lon: 1},
    {lat: 1, lon: 1},
    {lat: 1, lon: 0},
  ];
  it('detects an interior point', () => {
    expect(pointInPolygon({lat: 0.5, lon: 0.5}, square)).toBe(true);
  });
  it('rejects an exterior point', () => {
    expect(pointInPolygon({lat: 2, lon: 2}, square)).toBe(false);
  });
});

describe('distanceToSite (circle)', () => {
  it('is inside at the centre', () => {
    const d = distanceToSite({lat: 28.6139, lon: 77.209}, SITE_A);
    expect(d.insideSite).toBe(true);
    expect(d.distanceM).toBe(0);
  });
  it('reports metres outside the boundary when far away', () => {
    // ~0.01° north ≈ 1.11 km away, radius 100 m → ~1010 m outside.
    const d = distanceToSite({lat: 28.6239, lon: 77.209}, SITE_A);
    expect(d.insideSite).toBe(false);
    expect(d.distanceM).toBeGreaterThan(900);
  });
});

describe('evaluateGeofence', () => {
  it('passes inside the site with a good, non-mock fix', () => {
    const r = evaluateGeofence(fix({}), [SITE_A], OPTS);
    expect(r.passed).toBe(true);
    expect(r.reason).toBe('inside');
    expect(r.siteId).toBe('siteA');
  });

  it('fails a mock fix even when inside the site', () => {
    const r = evaluateGeofence(fix({mocked: true}), [SITE_A], OPTS);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('mocked');
    expect(r.mockRejected).toBe(true);
  });

  it('fails when horizontal accuracy is worse than the ceiling', () => {
    const r = evaluateGeofence(fix({accuracyM: 200}), [SITE_A], OPTS);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('poor_accuracy');
    expect(r.accuracyOk).toBe(false);
  });

  it('fails and reports distance when outside the site', () => {
    const r = evaluateGeofence(fix({lat: 28.63}), [SITE_A], OPTS);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('outside');
    expect(r.distanceM).toBeGreaterThan(0);
  });

  it('picks the nearest of several sites', () => {
    const far: Site = {
      id: 'far',
      name: 'Other',
      shape: {kind: 'circle', center: {lat: 19.076, lon: 72.877}, radiusM: 100},
    };
    const r = evaluateGeofence(fix({}), [far, SITE_A], OPTS);
    expect(r.siteId).toBe('siteA');
    expect(r.passed).toBe(true);
  });

  it('returns no_fix when there is no reading', () => {
    expect(evaluateGeofence(null, [SITE_A], OPTS).reason).toBe('no_fix');
  });

  it('returns no_sites when none are provisioned', () => {
    expect(evaluateGeofence(fix({}), [], OPTS).reason).toBe('no_sites');
  });
});
