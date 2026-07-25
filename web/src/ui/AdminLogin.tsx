/**
 * AdminLogin — gate for the NHAI admin dashboard. On success the app renders the
 * dashboard (geofencing now; enrollment via Supabase later).
 */
import {useState} from 'react';
import {login} from '../lib/adminAuth';

export default function AdminLogin({
  onLogin,
}: {
  onLogin: () => void;
}): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await login(username.trim(), password);
    setBusy(false);
    if (r.ok) {
      onLogin();
    } else {
      setError(r.error ?? 'Login failed');
    }
  };

  return (
    <div style={S.wrap}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.kicker}>DATALAKE 3.0 · ADMIN</div>
        <h1 style={S.title}>Face Auth Admin Console</h1>
        <p style={S.sub}>
          Sign in to provision geofences and manage field inspectors.
        </p>

        <label style={S.label}>Username</label>
        <input
          style={S.input}
          value={username}
          autoCapitalize="none"
          autoFocus
          onChange={e => setUsername(e.target.value)}
        />

        <label style={S.label}>Password</label>
        <input
          style={S.input}
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        {error && <div style={S.error}>{error}</div>}

        <button style={S.btn} type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#07090b',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    background: '#0d1216',
    border: '1px solid #25323b',
    borderRadius: 12,
    padding: 28,
    display: 'flex',
    flexDirection: 'column',
  },
  kicker: {color: '#38e0a5', fontSize: 10, fontWeight: 800, letterSpacing: 1.6},
  title: {color: '#dbe4e8', fontSize: 22, fontWeight: 900, margin: '6px 0 2px'},
  sub: {color: '#8b97a5', fontSize: 13, margin: '0 0 8px', lineHeight: 1.5},
  label: {color: '#8b97a5', fontSize: 11, marginTop: 14, marginBottom: 5},
  input: {
    background: '#111a21',
    border: '1px solid #25323b',
    color: '#dbe4e8',
    padding: '10px 11px',
    borderRadius: 6,
    fontSize: 14,
  },
  error: {
    color: '#ff6b6b',
    fontSize: 12,
    marginTop: 12,
    lineHeight: 1.5,
  },
  btn: {
    marginTop: 18,
    background: '#38e0a5',
    color: '#07100d',
    fontWeight: 900,
    border: 'none',
    borderRadius: 6,
    padding: 12,
    cursor: 'pointer',
    fontSize: 14,
  },
};
