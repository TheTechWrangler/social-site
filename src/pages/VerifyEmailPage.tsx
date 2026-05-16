import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';

type Status = 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // Guard against React StrictMode double-fire in development.
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    const token = params.get('token');
    if (!token) {
      setStatus('error');
      setErrorMsg('No verification token found in this link.');
      return;
    }

    api.verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err: any) => {
        setStatus('error');
        setErrorMsg(err.message || 'Invalid or expired verification link.');
      });
  }, []);

  if (status === 'loading') {
    return (
      <div className="auth-page">
        <p className="muted" style={{ textAlign: 'center' }}>Verifying your email address…</p>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="auth-page">
        <h2>Email verified!</h2>
        <p>Your email address has been verified. You now have full access to RefugeCloud.</p>
        <Link to="/" className="btn btn-primary" style={{ display: 'inline-block', marginTop: '8px' }}>
          Go to home
        </Link>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <h2>Verification failed</h2>
      <p className="error-msg" role="alert">{errorMsg}</p>
      <p className="muted">
        The link may have expired or already been used.{' '}
        <Link to="/login">Log in</Link> and request a new verification email from your account.
      </p>
    </div>
  );
}
