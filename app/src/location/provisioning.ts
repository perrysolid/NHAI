/**
 * provisioning — pull the geofence site(s) assigned to this inspector from the
 * admin backend and hand them back to be cached locally (MMKV). Called only when
 * the device is online; after one successful pull, the on-device geofence check
 * runs fully offline against the cached sites. Pure network + mapping, no storage
 * side-effects here, so it's easy to test.
 */
import type {LatLon, Site} from './types';

interface RemoteCircle {
  kind: 'circle';
  center: LatLon;
  radiusM: number;
}
interface RemoteSite {
  id: string;
  name: string;
  assignedUserId?: string;
  role?: string;
  shape: RemoteCircle;
}

function mapRemote(r: RemoteSite): Site | null {
  const s = r?.shape;
  if (!s || s.kind !== 'circle' || !s.center) {
    return null;
  }
  const lat = Number(s.center.lat);
  const lon = Number(s.center.lon);
  const radiusM = Number(s.radiusM);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0)) {
    return null;
  }
  return {
    id: String(r.id),
    name: String(r.name ?? 'Site'),
    assignedUserId: r.assignedUserId,
    role: r.role,
    shape: {kind: 'circle', center: {lat, lon}, radiusM},
  };
}

export interface ProvisionOptions {
  /** Backend origin, e.g. https://host (NOT including /api/...). */
  baseUrl: string;
  apiKey: string;
  userId: string;
  fetchImpl?: typeof fetch;
}

/** Fetch the sites assigned to `userId`. Throws on network/HTTP error. */
export async function fetchAssignedSites(
  opts: ProvisionOptions,
): Promise<Site[]> {
  const fetcher = opts.fetchImpl ?? fetch;
  const res = await fetcher(
    `${opts.baseUrl}/api/sites/for/${encodeURIComponent(opts.userId)}`,
    {headers: {'x-api-key': opts.apiKey}},
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => ({}))) as {sites?: RemoteSite[]};
  const sites = Array.isArray(data.sites) ? data.sites : [];
  return sites.map(mapRemote).filter((s): s is Site => s !== null);
}

/** Derive the backend origin from the configured SYNC.url (…/api/sync). */
export function baseUrlFromSyncUrl(syncUrl: string): string {
  return syncUrl.replace(/\/api\/sync\/?$/, '');
}
