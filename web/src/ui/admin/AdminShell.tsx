/**
 * AdminShell — the NHAI Datalake 3.0 admin console frame. A fixed command
 * sidebar (brand · nav · system status · sign-out) and a gridded canvas that
 * renders one admin surface at a time. This is the entire authed experience;
 * the old hackathon-demo surfaces are intentionally not reachable from here.
 */
import {useState} from 'react';
import './admin.css';
import InspectorsAdmin from '../InspectorsAdmin';
import GeofencingAdmin from '../GeofencingAdmin';
import AttendanceAdmin from '../AttendanceAdmin';

type AdminPage = 'inspectors' | 'geofencing' | 'attendance';

const NAV: {id: AdminPage; label: string; icon: React.JSX.Element}[] = [
  {
    id: 'inspectors',
    label: 'Inspectors',
    icon: (
      <svg className="navitem__icon" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
        <path d="M16 6.2a3 3 0 0 1 0 5.6M17 14c2.4.4 4 2.2 4 5" />
      </svg>
    ),
  },
  {
    id: 'geofencing',
    label: 'Geofencing',
    icon: (
      <svg className="navitem__icon" viewBox="0 0 24 24">
        <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
        <circle cx="12" cy="10" r="2.4" />
      </svg>
    ),
  },
  {
    id: 'attendance',
    label: 'Attendance',
    icon: (
      <svg className="navitem__icon" viewBox="0 0 24 24">
        <rect x="4" y="4.5" width="16" height="16" rx="2" />
        <path d="M8 3v3M16 3v3M4 9.5h16M8.5 14l2 2 4-4" />
      </svg>
    ),
  },
];

export default function AdminShell({
  onSignOut,
}: {
  onSignOut: () => void;
}): React.JSX.Element {
  const [page, setPage] = useState<AdminPage>('inspectors');
  const [prefill, setPrefill] = useState<{userId: string; role?: string} | null>(
    null,
  );

  return (
    <div className="admin">
      <aside className="side">
        <div className="side__brand">
          <div className="side__mark" aria-hidden>
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="side__name">Datalake Face Auth</div>
            <div className="side__sub">NHAI · Admin Console</div>
          </div>
        </div>

        <nav className="side__nav">
          <div className="side__label">Console</div>
          {NAV.map(item => (
            <button
              key={item.id}
              className={`navitem ${page === item.id ? 'navitem--active' : ''}`}
              onClick={() => setPage(item.id)}
              data-testid={`nav-${item.id}`}>
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="side__foot">
          <div className="side__status">
            <span className="side__dot" />
            SYSTEM ONLINE
          </div>
          <button className="side__signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        {page === 'inspectors' && (
          <InspectorsAdmin
            onAssign={insp => {
              setPrefill(insp);
              setPage('geofencing');
            }}
          />
        )}
        {page === 'geofencing' && <GeofencingAdmin prefill={prefill} />}
        {page === 'attendance' && <AttendanceAdmin />}
      </main>
    </div>
  );
}
