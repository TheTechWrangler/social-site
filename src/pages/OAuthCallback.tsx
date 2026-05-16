import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export default function OAuthCallback({ onLogin }: { onLogin: (u: any) => void }) {
  const navigate = useNavigate();
  // Guard against React StrictMode double-firing the effect in development.
  // The session handoff token is one-time-use on the server, so a second call would fail.
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    // The server stored the JWT in session during OAuth callback (never in the URL).
    // This call claims it, sets the HttpOnly auth cookie server-side, and returns the user.
    // The token is never exposed to JavaScript.
    fetch('/api/auth/oauth-token', { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error('OAuth token exchange failed');
        return r.json();
      })
      .then(({ user }: { user: any }) => {
        if (!user) throw new Error('No user in OAuth response');
        onLogin(user);
        navigate('/', { replace: true });
      })
      .catch(() => {
        navigate('/login?error=oauth_failed', { replace: true });
      });
  }, []);

  return <div className="loading">Completing login...</div>;
}
