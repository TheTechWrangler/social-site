import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';

type PageState = 'validating' | 'ready' | 'invalid' | 'success' | 'error';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [pageState, setPageState] = useState<PageState>('validating');
  const [username, setUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) { setPageState('invalid'); return; }
    api.validateResetToken(token)
      .then(r => { setUsername(r.username); setPageState('ready'); })
      .catch(() => setPageState('invalid'));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    if (newPassword.length < 8) { setErrorMsg('Password must be at least 8 characters.'); return; }
    if (newPassword !== confirm) { setErrorMsg('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      await api.submitPasswordReset(token, newPassword);
      setPageState('success');
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not reset password. The link may have expired.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="hero-landing" style={{ minHeight: '60vh', paddingTop: 60 }}>
      <h1 style={{ marginBottom: 8, fontSize: '1.8rem' }}>Password Reset</h1>

      {pageState === 'validating' && (
        <p className="muted">Verifying reset link…</p>
      )}

      {pageState === 'invalid' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', marginBottom: 16 }}>
            ⚠ This reset link is invalid or has expired.
          </p>
          <p className="muted" style={{ marginBottom: 16 }}>
            Reset links expire after 2 hours and can only be used once.<br />
            Contact an admin to request a new link.
          </p>
          <Link to="/login" className="btn-outline">Back to login</Link>
        </div>
      )}

      {pageState === 'ready' && (
        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="muted" style={{ margin: '0 0 4px' }}>
            Setting new password for <strong>@{username}</strong>
          </p>
          <input
            className="input"
            type="password"
            placeholder="New password (min 8 characters)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            required
            autoFocus
          />
          <input
            className="input"
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />
          {errorMsg && <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{errorMsg}</p>}
          <button className="btn-gold" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Set New Password'}
          </button>
          <Link to="/login" className="muted" style={{ textAlign: 'center', fontSize: '0.88rem' }}>Cancel</Link>
        </form>
      )}

      {pageState === 'success' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: 12 }}>
            ✅ Password updated successfully.
          </p>
          <p className="muted">Redirecting to login…</p>
          <Link to="/login" className="btn-gold" style={{ marginTop: 16, display: 'inline-block' }}>Log in now</Link>
        </div>
      )}
    </div>
  );
}
