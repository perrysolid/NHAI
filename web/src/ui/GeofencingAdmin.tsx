/**
 * GeofencingAdmin — Datalake-style geofence provisioning.
 *
 * An admin drops a circular work zone on a satellite map, assigns it to an
 * inspector (userId) with a Datalake role, and saves it to the backend. The
 * inspector's phone pulls its assigned site when online and caches it locally,
 * so the on-device geofence check then runs fully offline. Circle-only for now
 * (polygon/corridor is the documented Phase 2).
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {SYNC} from '../lib/config';
import {getToken} from '../lib/adminAuth';

/**
 * Fresh admin headers per request. Module scope on purpose: as a value built
 * during render it was captured by the useCallback closures below, so after a
 * re-login those handlers kept sending the PREVIOUS token — and adding it to
 * the dependency arrays would have defeated the memoisation, since the object
 * identity changed on every render. A function reads the current token at call
 * time and needs no dependency at all.
 */
function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': getToken(),
  };
}

interface Site {
  id: string;
  name: string;
  assignedUserId: string;
  role: string;
  shape: {kind: 'circle'; center: {lat: number; lon: number}; radiusM: number};
  updatedAt: number;
}

const ROLE_LABELS: Record<string, string> = {
  'authority-engineer': 'Authority Engineer (AE/IE)',
  contractor: 'Contractor',
  piu: 'PIU team',
  'regional-officer': 'Regional Officer',
  consultant: 'Consultant',
};

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

export default function GeofencingAdmin({
  prefill,
}: {
  prefill?: {userId: string; role?: string} | null;
}): React.JSX.Element {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const circleRef = useRef<L.Circle | null>(null);

  const [center, setCenter] = useState<{lat: number; lon: number} | null>(null);
  const [radiusM, setRadiusM] = useState(150);
  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('authority-engineer');
  const [roles, setRoles] = useState<string[]>(Object.keys(ROLE_LABELS));
  const [sites, setSites] = useState<Site[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState('Click the map to place a work-zone centre.');

  // Pre-fill the assignment form when an inspector is picked from the roster.
  useEffect(() => {
    if (prefill?.userId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing an incoming prop into local form state
      setUserId(prefill.userId);
      if (prefill.role) {
        setRole(prefill.role);
      }
      setStatus(`Assigning a zone to ${prefill.userId} — click the map to place it.`);
    }
  }, [prefill]);

  // Geocode a place name with OSM Nominatim and pan the map there.
  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      return;
    }
    setSearching(true);
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        {headers: {Accept: 'application/json'}},
      );
      const d = (await r.json()) as {lat: string; lon: string; display_name: string}[];
      if (d.length) {
        const lat = Number(d[0].lat);
        const lon = Number(d[0].lon);
        mapRef.current?.setView([lat, lon], 15);
        setStatus(`Found: ${d[0].display_name}. Click the map to place the zone.`);
      } else {
        setStatus(`No place found for "${q}".`);
      }
    } catch {
      setStatus('Place search failed (network).');
    } finally {
      setSearching(false);
    }
  }, [query]);


  // Init the Leaflet map once (satellite imagery + place labels).
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) {
      return;
    }
    const map = L.map(mapDivRef.current, {zoomControl: true}).setView(
      [22.9734, 78.6569], // India
      5,
    );
    L.tileLayer(ESRI_IMAGERY, {
      attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
    }).addTo(map);
    L.tileLayer(ESRI_LABELS, {maxZoom: 19}).addTo(map);
    map.on('click', e => setCenter({lat: e.latlng.lat, lon: e.latlng.lng}));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      circleRef.current = null;
    };
  }, []);

  // Keep the preview circle in sync with the chosen centre + radius.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) {
      return;
    }
    if (!circleRef.current) {
      circleRef.current = L.circle([center.lat, center.lon], {
        radius: radiusM,
        color: '#38e0a5',
        fillColor: '#38e0a5',
        fillOpacity: 0.15,
      }).addTo(map);
    } else {
      circleRef.current.setLatLng([center.lat, center.lon]);
      circleRef.current.setRadius(radiusM);
    }
  }, [center, radiusM]);

  const loadSites = useCallback(async () => {
    try {
      const r = await fetch(`${SYNC.url}/api/sites`, {headers: authHeaders()});
      const d = await r.json();
      if (d.ok) {
        setSites(d.sites);
      }
    } catch {
      /* backend may be offline in mock mode */
    }
  }, []);

  useEffect(() => {
    fetch(`${SYNC.url}/api/roles`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && Array.isArray(d.roles)) {
          setRoles(d.roles);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after async fetches, not synchronously
    loadSites();
  }, [loadSites]);

  const locateMe = useCallback(() => {
    navigator.geolocation?.getCurrentPosition(
      pos => {
        const c = {lat: pos.coords.latitude, lon: pos.coords.longitude};
        setCenter(c);
        mapRef.current?.setView([c.lat, c.lon], 16);
      },
      () => setStatus('Could not read your location.'),
      {enableHighAccuracy: true},
    );
  }, []);

  const save = useCallback(async () => {
    if (!center) {
      setStatus('Click the map to place the zone centre first.');
      return;
    }
    if (!userId.trim()) {
      setStatus('Enter the inspector ID to assign this zone to.');
      return;
    }
    const body = {
      name: name.trim() || 'Unnamed site',
      assignedUserId: userId.trim(),
      role,
      shape: {kind: 'circle', center, radiusM},
    };
    try {
      const r = await fetch(`${SYNC.url}/api/sites`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.ok) {
        setStatus(
          `Saved "${d.site.name}" → ${d.site.assignedUserId} (${ROLE_LABELS[d.site.role] ?? d.site.role}). It will provision to their device on next sync.`,
        );
        loadSites();
      } else {
        setStatus(d.error ?? 'Save failed.');
      }
    } catch {
      setStatus('Network error — is the backend reachable (VITE_SYNC_URL)?');
    }
  }, [center, name, userId, role, radiusM, loadSites]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${SYNC.url}/api/sites/${id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        loadSites();
      } catch {
        setStatus('Could not delete.');
      }
    },
    [loadSites],
  );

  const focusSite = useCallback((s: Site) => {
    setCenter(s.shape.center);
    setRadiusM(s.shape.radiusM);
    setName(s.name);
    setUserId(s.assignedUserId);
    setRole(s.role);
    mapRef.current?.setView([s.shape.center.lat, s.shape.center.lon], 15);
  }, []);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="page__kicker">DATALAKE 3.0 · GEOFENCE PROVISIONING</div>
          <h1 className="page__title">Assign a work zone to an inspector</h1>
          <p className="page__sub">
            Drop a circular zone on the satellite map and assign it to an
            inspector. It provisions to their device on next sync and is then
            enforced fully offline.
          </p>
        </div>
        <button className="btn btn--ghost" onClick={locateMe}>
          Use my location
        </button>
      </div>

      <div style={S.searchRow}>
        <input
          style={S.searchInput}
          value={query}
          placeholder="Search a place — town, highway, chainage, landmark…"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              search();
            }
          }}
        />
        <button className="btn btn--ghost" onClick={search} disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      <div style={S.grid}>
        <div ref={mapDivRef} style={S.map} />

        <div style={S.panel}>
          <label style={S.label}>Zone name</label>
          <input
            style={S.input}
            value={name}
            placeholder="e.g. Chainage 12+400 — pier P3"
            onChange={e => setName(e.target.value)}
          />

          <label style={S.label}>Assign to inspector (userId)</label>
          <input
            style={S.input}
            value={userId}
            placeholder="inspector_01"
            autoCapitalize="none"
            onChange={e => setUserId(e.target.value)}
          />

          <label style={S.label}>Role</label>
          <select style={S.input} value={role} onChange={e => setRole(e.target.value)}>
            {roles.map(r => (
              <option key={r} value={r}>
                {ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>

          <label style={S.label}>
            Radius: <b style={{color: '#38e0a5'}}>{radiusM} m</b>
          </label>
          <input
            type="range"
            min={20}
            max={2000}
            step={10}
            value={radiusM}
            onChange={e => setRadiusM(Number(e.target.value))}
            style={{width: '100%'}}
          />

          <div style={S.coords}>
            {center
              ? `centre: ${center.lat.toFixed(5)}, ${center.lon.toFixed(5)}`
              : 'centre: click the map'}
          </div>

          <button style={S.primaryBtn} onClick={save}>
            Save &amp; assign zone
          </button>
          <div style={S.status}>{status}</div>
        </div>
      </div>

      <div style={S.listCard}>
        <div style={S.kicker}>PROVISIONED ZONES ({sites.length})</div>
        {sites.length === 0 ? (
          <div style={S.empty}>
            No zones yet. Drop one on the map and assign it to an inspector.
          </div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Zone</th>
                <th style={S.th}>Inspector</th>
                <th style={S.th}>Role</th>
                <th style={S.th}>Radius</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {sites.map(s => (
                <tr key={s.id}>
                  <td style={S.td}>
                    <button style={S.linkBtn} onClick={() => focusSite(s)}>
                      {s.name}
                    </button>
                  </td>
                  <td style={S.tdMono}>{s.assignedUserId}</td>
                  <td style={S.td}>{ROLE_LABELS[s.role] ?? s.role}</td>
                  <td style={S.tdMono}>{s.shape.radiusM} m</td>
                  <td style={S.td}>
                    <button style={S.delBtn} onClick={() => remove(s.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {padding: '20px 22px', color: '#dbe4e8'},
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 16,
  },
  kicker: {
    color: '#38e0a5',
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 1.6,
  },
  title: {margin: '4px 0 0', fontSize: 22, fontWeight: 900},
  grid: {display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 14},
  map: {
    height: 460,
    borderRadius: 10,
    border: '1px solid #25323b',
    overflow: 'hidden',
  },
  panel: {
    background: '#0d1216',
    border: '1px solid #25323b',
    borderRadius: 10,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
  },
  label: {fontSize: 11, color: '#8b97a5', marginTop: 12, marginBottom: 5},
  input: {
    background: '#111a21',
    border: '1px solid #25323b',
    color: '#dbe4e8',
    padding: '9px 10px',
    borderRadius: 6,
    fontSize: 14,
  },
  searchRow: {display: 'flex', gap: 8, marginBottom: 12},
  searchInput: {
    flex: 1,
    background: '#111a21',
    border: '1px solid #25323b',
    color: '#dbe4e8',
    padding: '10px 12px',
    borderRadius: 7,
    fontSize: 14,
  },
  coords: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 12,
    color: '#76858d',
    marginTop: 12,
  },
  primaryBtn: {
    marginTop: 14,
    background: '#38e0a5',
    color: '#07100d',
    fontWeight: 900,
    border: 'none',
    borderRadius: 6,
    padding: '11px',
    cursor: 'pointer',
  },
  ghostBtn: {
    background: 'transparent',
    color: '#38e0a5',
    border: '1px solid #38e0a5',
    borderRadius: 6,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 700,
  },
  status: {fontSize: 12, color: '#8b97a5', marginTop: 10, lineHeight: 1.5},
  listCard: {
    marginTop: 18,
    background: '#0d1216',
    border: '1px solid #25323b',
    borderRadius: 10,
    padding: 14,
  },
  empty: {color: '#46535b', fontFamily: 'ui-monospace, monospace', padding: '16px 0'},
  table: {width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 13},
  th: {
    textAlign: 'left',
    color: '#46535b',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    padding: '8px 10px',
    borderBottom: '1px solid #1a242c',
  },
  td: {padding: '10px', borderBottom: '1px solid #1a242c'},
  tdMono: {
    padding: '10px',
    borderBottom: '1px solid #1a242c',
    fontFamily: 'ui-monospace, monospace',
    color: '#8b97a5',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: '#38e0a5',
    cursor: 'pointer',
    fontWeight: 700,
    padding: 0,
    fontSize: 13,
  },
  delBtn: {
    background: 'none',
    border: '1px solid #ff6b6b',
    color: '#ff6b6b',
    borderRadius: 5,
    padding: '4px 9px',
    cursor: 'pointer',
    fontSize: 12,
  },
};
