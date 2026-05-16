import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

const API_BASE = '';

export default function LoginPage({ onLogin }: { onLogin: (u: any) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [params] = useSearchParams();
  const oauthError = params.get('error');
  const [providers, setProviders] = useState<{ google: boolean; steam: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/providers`)
      .then(r => r.json()).then(setProviders).catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const r = await api.login({ username, password });
      localStorage.setItem('token', r.token);
      localStorage.setItem('user', JSON.stringify(r.user));
      onLogin(r.user);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  const displayError = error
    || (oauthError === 'google_failed' ? 'Google login failed. Please try again.'
    : oauthError === 'steam_failed' ? 'Steam login failed. Please try again.'
    : oauthError === 'google_not_configured' ? 'Google login is not configured yet. Add GOOGLE_CLIENT_ID to .env'
    : oauthError === 'steam_not_configured' ? 'Steam login is not configured yet. Add STEAM_RETURN_URL to .env'
    : oauthError === 'oauth_failed' ? 'Social login failed. Please try again.' : '');

  return (
    <div className="auth-page">
      <h2>Log In</h2>

      {/* Social login buttons */}
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
        <input className="input" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required autoComplete="username" />
        <input className="input" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
        {displayError && <p className="error-msg" role="alert">{displayError}</p>}
        <button className="btn btn-primary" disabled={loading}>{loading ? 'Logging in...' : 'Log In'}</button>
      </form>
      <p className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>Forgot your password? Contact an admin for a reset link.</p>
      <p className="muted">Don't have an account? <Link to="/register">Register</Link></p>
    </div>
  );
}
