'use client';

import { useState } from 'react';

export default function LoginForm() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'cryptoalgo' },
        body: JSON.stringify({ username, password }),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 423 ? 'Too many failed attempts. Try again in 15 minutes.' : res.status === 429 ? 'Too many requests. Slow down.' : res.status === 502 ? 'The trading backend is not reachable.' : 'Invalid username or password.');
        setBusy(false);
        return;
      }
      void data;
      window.location.href = '/';
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  return (
    <form className="card login-card" onSubmit={submit} aria-labelledby="login-title">
      <h2 id="login-title" style={{ fontSize: 20 }}>CryptoAlgo</h2>
      <p className="sec" style={{ margin: '4px 0 14px' }}>ETH perpetual scalper · starts in <b>DEMO</b> mode</p>
      <div className="field">
        <label htmlFor="u">Username</label>
        <input id="u" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="p">Password</label>
        <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </div>
      {error && <p className="bad" role="alert" style={{ margin: '10px 0 0', fontWeight: 600 }}>{error}</p>}
      <button className="btn primary" style={{ width: '100%', marginTop: 14 }} disabled={busy || !username || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
