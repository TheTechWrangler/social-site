import { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

export default function OAuthCallback({ onLogin }: { onLogin: (u: any) => void }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const token = params.get('token');
    const username = params.get('username');
    if (token) {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify({ username }));
      onLogin({ username });
      navigate('/', { replace: true });
    } else {
      navigate('/login?error=oauth_failed', { replace: true });
    }
  }, []);

  return <div className="loading">Completing login...</div>;
}
