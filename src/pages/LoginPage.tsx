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
  // Unverified-account state: show after a successful login for an unverified user.
  const [unverifiedUser, setUnverifiedUser] = useState<any>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/providers`)
      .then(r => r.json()).then(setProviders).catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const r = await api.login({ username, password });
      if (r.user && !r.user.is_verified) {
        // Logged in but not yet verified — show resend guidance before continuing.
        setUnverifiedUser(r.user);
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

  const displayError = error
    || (oauthError === 'google_failed' ? 'Google login failed. Please try again.'
    : oauthError === 'steam_failed' ? 'Steam login failed. Please try again.'
    : oauthError === 'google_not_configured' ? 'Google login is not configured yet. Add GOOGLE_CLIENT_ID to .env'
    : oauthError === 'steam_not_configured' ? 'Steam login is not configured yet. Add STEAM_RETURN_URL to .env'
    : oauthError === 'oauth_failed' ? 'Social login failed. Please try again.' : '');

  // ─── Forgot-password inline form state ───
  const [showForgot, setShowForgot] = useState(false);
  const [forgotInput, setForgotInput] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMsg, setForgotMsg] = useState('');

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      await api.forgotPassword(forgotInput.trim());
      setForgotMsg('If an account with a local password matches, a password reset email has been sent.');
    } catch {
      // Always show generic message — never reveal whether account exists.
      setForgotMsg('If an account with a local password matches, a password reset email has been sent.');
    }
    setForgotLoading(false);
  }

  // ─── Post-login: unverified account guidance ───
  if (unverifiedUser) {
    return (
      <div className="auth-page">
        <h2>Email not verified</h2>
        <p>
          You're logged in, but your email address hasn't been verified yet.
          Some features (posting, comments, likes) require a verified account.
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
        <button className="btn btn-primary" onClick={() => onLogin(unverifiedUser)}>
          Continue anyway
        </button>
      </div>
    );
  }

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
        <button className="btn btn-primary" disabled={loading}>{loading ? 'Logging in…' : 'Log In'}</button>
      </form>
      {/* ─── Forgot-password inline section ─── */}
      {!showForgot && !forgotMsg && (
        <p className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>
          <button type="button" className="btn-link" onClick={() => setShowForgot(true)}>
            Forgot your password?
          </button>
        </p>
      )}
      {showForgot && !forgotMsg && (
        <form onSubmit={handleForgotSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 4px' }}>
            Password reset emails are only sent for accounts created with an email and password.
            If you log in with Google or Steam, reset your password through Google or Steam instead.
          </p>
          <input
            className="input"
            placeholder="Email or username"
            value={forgotInput}
            onChange={e => setForgotInput(e.target.value)}
            required
            autoComplete="email"
          />
          <button className="btn btn-secondary" disabled={forgotLoading} type="submit">
            {forgotLoading ? 'Sending…' : 'Send reset email'}
          </button>
          <button
            type="button"
            className="btn-link"
            onClick={() => { setShowForgot(false); setForgotInput(''); }}
            style={{ fontSize: '0.85rem', textAlign: 'center' }}
          >
            Cancel
          </button>
        </form>
      )}
      {forgotMsg && (
        <p className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>{forgotMsg}</p>
      )}
      <p className="muted">Don't have an account? <Link to="/register">Register</Link></p>
    </div>
  );
}
