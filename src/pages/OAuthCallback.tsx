import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export default function OAuthCallback({ onLogin }: { onLogin: (u: any) => void }) {
  const navigate = useNavigate();
  // Guard against React StrictMode double-firing the effect in development.
  // The token is one-time-use on the server, so a second fetch would fail.
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    // The server stored the JWT in the session during the OAuth callback — not in the URL.
    // We retrieve it here via a credentialed fetch (session cookie sent automatically).
    fetch('/api/auth/oauth-token', { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error('OAuth token exchange failed');
        return r.json();
      })
      .then(({ token, username }: { token: string; username: string }) => {
        if (!token) throw new Error('No token in response');
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify({ username }));
        onLogin({ username });
        navigate('/', { replace: true });
      })
      .catch(() => {
        navigate('/login?error=oauth_failed', { replace: true });
      });
  }, []);

  return <div className="loading">Completing login...</div>;
}
