import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

const API_BASE = '';

export default function RegisterPage({ onLogin }: { onLogin: (u: any) => void }) {
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<{ google: boolean; steam: boolean } | null>(null);
  // After successful registration, show the "check your email" state.
  const [registeredUser, setRegisteredUser] = useState<any>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

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
      if (r.needsEmailVerification) {
        // User is logged in (cookie set), but email not yet verified.
        // Show the check-email state rather than navigating away.
        setRegisteredUser(r.user);
      } else {
        onLogin(r.user);
      }
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleResend() {
    setResendLoading(true); setResendMsg('');
    try {
      await api.resendVerification();
      setResendMsg('Verification email sent! Check your inbox.');
    } catch {
      setResendMsg('Could not send email. Please try again later.');
    }
    setResendLoading(false);
  }

  // ─── Post-registration: check-your-email state ───
  if (registeredUser) {
    return (
      <div className="auth-page">
        <h2>Check your email</h2>
        <p>
          We sent a verification link to <strong>{form.email}</strong>.
          Click it to unlock full access. You can continue exploring the site in the meantime —
          some features require verification.
        </p>
        {resendMsg && <p className="muted" style={{ marginBottom: '8px' }}>{resendMsg}</p>}
        <button
          className="btn btn-secondary"
          onClick={handleResend}
          disabled={resendLoading}
          style={{ marginBottom: '12px' }}
        >
          {resendLoading ? 'Sending…' : 'Resend verification email'}
        </button>
        <br />
        <button className="btn btn-primary" onClick={() => onLogin(registeredUser)}>
          Continue to site
        </button>
      </div>
    );
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
        <input className="input" placeholder="Username" value={form.username} onChange={set('username')} required autoComplete="username" />
        <input className="input" placeholder="Display Name" value={form.displayName} onChange={set('displayName')} required autoComplete="name" />
        <input className="input" type="email" placeholder="Email" value={form.email} onChange={set('email')} required autoComplete="email" />
        <input className="input" type="password" placeholder="Password (8+ characters)" value={form.password} onChange={set('password')} required minLength={8} autoComplete="new-password" />
        {error && <p className="error-msg" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={loading}>{loading ? 'Creating…' : 'Register'}</button>
      </form>
      <p className="muted">Already have an account? <Link to="/login">Log in</Link></p>
    </div>
  );
}
