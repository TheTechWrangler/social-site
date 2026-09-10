import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { api } from './api/client';
import { usePageTracking } from './hooks/usePageTracking';
import { RouteRequestGate } from './routeLoadState';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ProfilePage from './pages/ProfilePage';
import GroupPage from './pages/GroupPage';
import GroupsPage from './pages/GroupsPage';
import NotificationsPage from './pages/NotificationsPage';
import AdminPage from './pages/AdminPage';
import WorldPage from './pages/WorldPage';
import DiscoverPage from './pages/DiscoverPage';
import FriendsPage from './pages/FriendsPage';
import GamesPage from './pages/GamesPage';
import SettingsPage from './pages/SettingsPage';
import GameDetailPage from './pages/GameDetailPage';
import OAuthCallback from './pages/OAuthCallback';
import LandingPage from './pages/LandingPage';
import PostDetailPage from './pages/PostDetailPage';
import MessagesPage from './pages/MessagesPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [initializing, setInitializing] = useState(true);
  const [unread, setUnread] = useState(0);
  const [dmUnread, setDmUnread] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  usePageTracking();
  const isAdminPage = location.pathname === '/admin';

  // On mount: check whether the auth cookie is still valid by calling /me.
  // This is the single source of truth for login state — no localStorage token.
  useEffect(() => {
    // Scrub any stale localStorage token/user from the old Bearer-based auth system.
    localStorage.removeItem('token');
    localStorage.removeItem('user');

    api.me()
      .then(r => { setUser(r.user); })
      .catch(() => { /* Not logged in or cookie expired — render as logged out */ })
      .finally(() => { setInitializing(false); });
  }, []);

  useEffect(() => {
    // Global unhandled error reporter — sends a generic signal only (no stack traces or PII).
    // sessionStorage dedup: at most one report per route per browser session.
    const handler = (_event: ErrorEvent) => {
      const safeRoute = window.location.pathname.replace(/\/\d+/g, '/:id');
      const dedupKey = `err_reported_${safeRoute}`;
      if (sessionStorage.getItem(dedupKey)) return;
      sessionStorage.setItem(dedupKey, '1');
      fetch('/api/usage/event', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'client_error', route: safeRoute, errorCode: 'UNHANDLED_ERROR' }),
      }).catch(() => {});
    };
    window.addEventListener('error', handler);
    return () => window.removeEventListener('error', handler);
  }, []);

  useEffect(() => {
    const gate = new RouteRequestGate();
    let inFlight = false;
    if (!user) {
      setUnread(0);
      setDmUnread(0);
      return () => gate.invalidate();
    }
    const accountId = user.id;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const isCurrent = gate.begin();
      const [notificationResult, messageResult] = await Promise.allSettled([
        api.unreadCount(),
        api.dmUnreadCount(),
      ]);
      if (isCurrent() && user.id === accountId) {
        if (notificationResult.status === 'fulfilled') setUnread(notificationResult.value.count);
        if (messageResult.status === 'fulfilled') setDmUnread(messageResult.value.count);
      }
      inFlight = false;
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 30000);
    return () => {
      gate.invalidate();
      window.clearInterval(interval);
    };
  }, [user?.id]);

  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  async function logout() {
    setLogoutError('');
    try {
      await api.logout();
      setUser(null);
      setUnread(0);
      setDmUnread(0);
      navigate('/login');
    } catch {
      setLogoutError('Could not log out. Please try again.');
    }
  }

  // Show a brief loading screen while we wait for the /me check on startup.
  if (initializing) return <div className="loading">Loading...</div>;

  return (
    <div className={`app-layout ${isAdminPage ? 'admin-layout' : ''}`}>
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <nav className={`sidebar-left ${mobileNavOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <Link to="/">☁ Refuge Cloud</Link>
          <button className="mobile-menu-btn" onClick={() => setMobileNavOpen(!mobileNavOpen)} aria-expanded={mobileNavOpen} aria-label="Toggle navigation">☰</button>
        </div>
        <div className="sidebar-links">
          <div className="nav-group">
            <span className="nav-group-label">Social</span>
            <Link to="/">🏠 Home</Link>
            {user && <Link to={`/profile/${user.username}`}>👤 Profile</Link>}
            {user && <Link to="/discover">🔍 Discover</Link>}
            {user && <Link to="/friends">👥 Friends</Link>}
            {user && <Link to="/groups">👥 Groups</Link>}
          </div>
          <div className="nav-group">
            <span className="nav-group-label">Media & Gaming</span>
            <Link to="/world">🌍 World</Link>
            <Link to="/games">🎮 Games</Link>
          </div>
          {user && (
            <div className="nav-group">
              <span className="nav-group-label">Account</span>
              <Link to="/notifications">🔔 Notifications {unread > 0 && <span className="badge">{unread}</span>}</Link>
              <Link to="/messages">💬 Messages {dmUnread > 0 && <span className="badge">{dmUnread}</span>}</Link>
              <Link to="/settings">⚙ Settings</Link>
            </div>
          )}
          {user?.role === 'admin' && (
            <div className="nav-group">
              <span className="nav-group-label">Admin</span>
              <Link to="/admin">🛡 Admin</Link>
            </div>
          )}
        </div>
        <div className="sidebar-user">
          {user ? (
            <>
              <span className="user-info">{user.display_name}</span>
              <button onClick={logout} className="btn-link">Log out</button>
              {logoutError && <span className="error-msg" role="alert">{logoutError}</span>}
            </>
          ) : (
            <>
              <Link to="/login">Log in</Link>
              <Link to="/register">Register</Link>
            </>
          )}
        </div>
      </nav>

      <main className="main-content">
        <Routes>
          <Route path="/login" element={!user ? <LoginPage onLogin={setUser} /> : <Navigate to="/" />} />
          <Route path="/register" element={!user ? <RegisterPage onLogin={setUser} /> : <Navigate to="/" />} />
          <Route path="/" element={user ? <HomePage user={user} onUserChange={setUser} /> : <LandingPage />} />
          <Route path="/profile/:username" element={user ? <ProfilePage user={user} onUserChange={setUser} /> : <Navigate to="/login" />} />
          <Route path="/groups" element={user ? <GroupsPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/groups/:id" element={user ? <GroupPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/notifications" element={user ? <NotificationsPage onMarkAllRead={() => setUnread(0)} onMarkOneRead={() => setUnread(prev => Math.max(0, prev - 1))} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={user?.role === 'admin' ? <AdminPage user={user} /> : <Navigate to="/" />} />
          <Route path="/world" element={<WorldPage user={user} />} />
          <Route path="/discover" element={user ? <DiscoverPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/friends" element={user ? <FriendsPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:slug" element={<GameDetailPage user={user} />} />
          <Route path="/settings" element={user ? <SettingsPage user={user} onUserChange={setUser} /> : <Navigate to="/login" />} />
          <Route path="/messages" element={user ? <MessagesPage user={user} onUnreadChange={setDmUnread} /> : <Navigate to="/login" />} />
          <Route path="/messages/:conversationId" element={user ? <MessagesPage user={user} onUnreadChange={setDmUnread} /> : <Navigate to="/login" />} />
          <Route path="/posts/:id" element={user ? <PostDetailPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage onLogin={setUser} />} />
          <Route path="/oauth/callback" element={<OAuthCallback onLogin={setUser} />} />
        </Routes>
      </main>

      {!isAdminPage && (
        <aside className="sidebar-right">
        <div className="sidebar-section">
          <h4>About</h4>
          <p className="muted">No ads. No algorithms. Just people.</p>
        </div>
        {user && (
          <div className="sidebar-section">
            <h4>Quick Links</h4>
            <Link to="/groups" className="sidebar-link-sm">Browse Groups</Link>
          </div>
        )}
        </aside>
      )}
    </div>
  );
}
