import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { api } from './api/client';
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
import OAuthCallback from './pages/OAuthCallback';
import LandingPage from './pages/LandingPage';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  useEffect(() => {
    if (token) {
      api.me().then(r => setUser(r.user)).catch(() => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      });
    }
  }, [token]);

  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      api.unreadCount().then(r => setUnread(r.count)).catch(() => {});
    }, 30000);
    api.unreadCount().then(r => setUnread(r.count)).catch(() => {});
    return () => clearInterval(interval);
  }, [user]);

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    navigate('/login');
  }

  if (!user && token) return <div className="loading">Loading...</div>;

  return (
    <div className="app-layout">
      <nav className="sidebar-left">
        <div className="sidebar-brand">
          <Link to="/">💬 Social</Link>
        </div>
        <div className="sidebar-links">
          <Link to="/">🏠 Home</Link>
          {user && <Link to="/discover">🔍 Discover</Link>}
          {user && <Link to="/friends">👥 Friends</Link>}
          <Link to="/world">🌍 World</Link>
          {user && <Link to={`/profile/${user.username}`}>👤 Profile</Link>}
          <Link to="/groups">👥 Groups</Link>
          {user && <Link to="/notifications">🔔 Notifications {unread > 0 && <span className="badge">{unread}</span>}</Link>}
          {user?.role === 'admin' && <Link to="/admin">🛡 Admin</Link>}
        </div>
        <div className="sidebar-user">
          {user ? (
            <>
              <span className="user-info">{user.display_name}</span>
              <button onClick={logout} className="btn-link">Log out</button>
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
          <Route path="/" element={user ? <HomePage user={user} /> : <LandingPage />} />
          <Route path="/profile/:username" element={user ? <ProfilePage user={user} /> : <Navigate to="/login" />} />
          <Route path="/groups" element={user ? <GroupsPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/groups/:id" element={user ? <GroupPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/notifications" element={user ? <NotificationsPage /> : <Navigate to="/login" />} />
          <Route path="/admin" element={user?.role === 'admin' ? <AdminPage /> : <Navigate to="/" />} />
          <Route path="/world" element={<WorldPage />} />
          <Route path="/discover" element={user ? <DiscoverPage /> : <Navigate to="/login" />} />
          <Route path="/friends" element={user ? <FriendsPage user={user} /> : <Navigate to="/login" />} />
          <Route path="/oauth/callback" element={<OAuthCallback onLogin={setUser} />} />
        </Routes>
      </main>

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
    </div>
  );
}
