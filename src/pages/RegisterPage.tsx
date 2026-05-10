import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

const API_BASE = '';

export default function RegisterPage({ onLogin }: { onLogin: (u: any) => void }) {
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<{ google: boolean; steam: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/providers`)
      .then(r => r.json()).then(setProviders).catch(() => {});
  }, []);

  function set(k: string) { return (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const r = await api.register(form);
      localStorage.setItem('token', r.token);
      localStorage.setItem('user', JSON.stringify(r.user));
      onLogin(r.user);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  return (
    <div className="auth-page">
      <h2>Create Account</h2>

      <div className="social-buttons">
        {providers?.google ? (
          <a href={`${API_BASE}/api/auth/google`} className="btn btn-social btn-google">
            <span className="social-icon">G</span> Continue with Google
          </a>
        ) : (
          <p className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>
            Google login is not configured.
          </p>
        )}
        {providers?.steam ? (
          <a href={`${API_BASE}/api/auth/steam`} className="btn btn-social btn-steam">
            <span className="social-icon">🎮</span> Continue with Steam
          </a>
        ) : (
          <p className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>
            Steam login is not configured.
          </p>
        )}
      </div>

      <div className="divider"><span>or</span></div>

      <form onSubmit={handleSubmit}>
        <input className="input" placeholder="Username" value={form.username} onChange={set('username')} required />
        <input className="input" placeholder="Display Name" value={form.displayName} onChange={set('displayName')} required />
        <input className="input" type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
        <input className="input" type="password" placeholder="Password (6+ chars)" value={form.password} onChange={set('password')} required />
        {error && <p className="error-msg">{error}</p>}
        <button className="btn btn-primary" disabled={loading}>{loading ? 'Creating...' : 'Register'}</button>
      </form>
      <p className="muted">Already have an account? <Link to="/login">Log in</Link></p>
    </div>
  );
}
