import { useState, useEffect, Fragment } from 'react';
import { api } from '../api/client';

type ReportFilter = 'open' | 'dismissed' | 'resolved' | 'all';
const REPORT_FILTERS: ReportFilter[] = ['open', 'dismissed', 'resolved', 'all'];
const REPORT_FILTER_LABELS: Record<ReportFilter, string> = { open: 'Open', dismissed: 'Dismissed', resolved: 'Resolved', all: 'All' };
const REPORT_STATUS_LABELS: Record<string, string> = { open: 'Open', dismissed: 'Dismissed', resolved: 'Resolved (Hidden)' };

const EVENT_TYPE_LABELS: Record<string, string> = {
  login_success: '✅ Login', login_failure: '❌ Login failed', register_success: '🆕 Register',
  oauth_success: '✅ OAuth', oauth_failure: '❌ OAuth failed',
  password_reset_requested: '🔑 Reset requested', password_reset_completed: '✅ Password reset',
  admin_ban: '🚫 Banned', admin_unban: '✓ Unbanned', admin_role_change: '👑 Role changed',
  admin_delete_user: '🗑 User deleted', admin_verify_user: '✅ Verified', admin_unverify_user: '⚠ Unverified',
  admin_password_reset_token: '🔑 Reset token generated',
  admin_self_ban_blocked: '🚫 Self-ban blocked',
  admin_last_admin_ban_blocked: '🚫 Last admin ban blocked',
  admin_last_admin_demote_blocked: '👑 Last admin demotion blocked',
};

// ── Backup tab helpers ────────────────────────────────────────────────────────
function formatBackupAge(ageHours: number): string {
  if (ageHours < 1) return `${Math.round(ageHours * 60)} min ago`;
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  return `${(ageHours / 24).toFixed(1)}d ago`;
}
function formatBytes(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? bytes : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;
  if (safeBytes < 1_048_576) return `${(safeBytes / 1024).toFixed(1)} KB`;
  return `${(safeBytes / 1_048_576).toFixed(1)} MB`;
}
function backupHealthStatus(s: any): { label: string; color: string } {
  if (!s?.backupDirExists || s?.backupCount === 0) return { label: '❌ No Backups Found', color: 'var(--danger)' };
  if (s?.integrityCheck === 'failed')              return { label: '❌ Integrity Check Failed', color: 'var(--danger)' };
  if (!s?.uploadBackups?.uploadsCovered)           return { label: '⚠ Upload Backups Missing', color: '#f59e0b' };
  if ((s?.latestBackup?.ageHours ?? 0) > 48)       return { label: '⚠ Backup Overdue', color: '#f59e0b' };
  if ((s?.uploadBackups?.latestBackup?.ageHours ?? 0) > 48)
                                                    return { label: '⚠ Upload Backup Overdue', color: '#f59e0b' };
  if (s?.timerActive && s.timerActive !== 'active' && s.timerActive !== 'unavailable')
                                                    return { label: '⚠ Timer Inactive', color: '#f59e0b' };
  return { label: '✅ Healthy', color: 'var(--green)' };
}

function UserDetailPanel({ act, resetLink, generatingReset, onGenerateReset, onDismissReset, onCopyLink }: {
  act: any; resetLink?: { link: string; expiresAt: string }; generatingReset: boolean;
  onGenerateReset: () => void; onDismissReset: () => void; onCopyLink: () => void;
}) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 16, marginTop: 4 }}>
      {!act ? <p className="muted">Loading…</p> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 8, marginBottom: 14, fontSize: '0.82rem' }}>
            <div><span className="muted">User ID</span><br /><strong>#{act.user.id}</strong></div>
            <div><span className="muted">Email</span><br /><strong>{act.user.email || '—'}</strong></div>
            <div><span className="muted">Joined</span><br /><strong>{act.user.created_at?.slice(0,10) || '—'}</strong></div>
            <div><span className="muted">Last login</span><br /><strong>{act.user.last_login_at?.slice(0,16).replace('T',' ') || 'Never'}</strong></div>
            <div><span className="muted">Posts</span><br /><strong>{act.postCount}</strong></div>
            <div><span className="muted">Comments</span><br /><strong>{act.commentCount}</strong></div>
            {act.providers.length > 0 && (
              <div><span className="muted">OAuth</span><br /><strong>{act.providers.map((p: any) => p.provider).join(', ')}</strong></div>
            )}
          </div>
          <div style={{ marginBottom: 12 }}>
            {resetLink ? (
              <div style={{ padding: '10px 12px', background: 'var(--panel)', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem' }}>
                <strong>Reset link (expires {new Date(resetLink.expiresAt).toLocaleString()}):</strong>
                <div style={{ marginTop: 6, wordBreak: 'break-all', fontFamily: 'monospace', color: 'var(--accent-text)' }}>{resetLink.link}</div>
                <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={onCopyLink}>Copy Link</button>
                <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={onDismissReset}>Dismiss</button>
              </div>
            ) : (
              <button className="btn btn-sm" disabled={generatingReset} onClick={onGenerateReset}>
                {generatingReset ? 'Generating…' : '🔑 Generate Password Reset Link'}
              </button>
            )}
          </div>
          <div style={{ fontSize: '0.82rem' }}>
            <strong style={{ display: 'block', marginBottom: 6 }}>Recent auth events</strong>
            {act.events.length === 0 ? <p className="muted">No events yet.</p> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
                  <th style={{ paddingRight: 10 }}>Event</th><th style={{ paddingRight: 10 }}>Result</th>
                  <th style={{ paddingRight: 10 }}>IP</th><th>When</th>
                </tr></thead>
                <tbody>{act.events.map((ev: any) => (
                  <tr key={ev.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ paddingRight: 10, paddingTop: 4 }}>{EVENT_TYPE_LABELS[ev.event_type] || ev.event_type}</td>
                    <td style={{ paddingRight: 10, color: ev.success ? 'var(--green)' : 'var(--danger)' }}>{ev.success ? 'OK' : ev.reason || 'Fail'}</td>
                    <td style={{ paddingRight: 10 }} className="muted">{ev.ip_address || '—'}</td>
                    <td className="muted">{ev.created_at?.slice(0,16).replace('T',' ')}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function AdminPage({ user: currentUser }: { user: any }) {
  const [users, setUsers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [tab, setTab] = useState<'users' | 'posts' | 'reports' | 'rss' | 'servers' | 'auth-logs' | 'health' | 'analytics' | 'backups'>('users');

  // RSS state
  const [rssSources, setRssSources] = useState<any[]>([]);
  const [rssName, setRssName] = useState('');
  const [rssUrl, setRssUrl] = useState('');
  const [rssHomepage, setRssHomepage] = useState('');
  const [rssCategory, setRssCategory] = useState('general');
  const [rssFetchResult, setRssFetchResult] = useState<any>(null);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [rssCatFilter, setRssCatFilter] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [userLimit, setUserLimit] = useState(50);
  const [userTotal, setUserTotal] = useState(0);
  const [userTotalPages, setUserTotalPages] = useState(1);
  const [activeAdminTotal, setActiveAdminTotal] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userRoleDraft, setUserRoleDraft] = useState<Record<number, string>>({});
  const [roleMsg, setRoleMsg] = useState('');
  const [tabError, setTabError] = useState<Record<string, string>>({});
  const [adminStats, setAdminStats] = useState<any>({});
  const [reportFilter, setReportFilter] = useState<ReportFilter>('open');
  const [reportActionError, setReportActionError] = useState('');
  const [reportNotes, setReportNotes] = useState<Record<number, string>>({});
  const [serverList, setServerList] = useState<any[]>([]);
  const [srvForm, setSrvForm] = useState({ gameId: '', name: '', connection_host: '', connection_port: '', platform: '', status: 'online', max_players: '', description: '', join_instructions: '' });

  // Auth logs
  const [authEvents, setAuthEvents] = useState<any[]>([]);
  const [authEventType, setAuthEventType] = useState('');
  const [authEventSuccess, setAuthEventSuccess] = useState('');
  const [authEventsLoading, setAuthEventsLoading] = useState(false);
  const [authEventPage, setAuthEventPage] = useState(1);
  const [authEventLimit, setAuthEventLimit] = useState(100);
  const [authEventTotal, setAuthEventTotal] = useState(0);
  const [authEventTotalPages, setAuthEventTotalPages] = useState(1);

  // System health
  const [systemHealth, setSystemHealth] = useState<any>(null);

  // Analytics
  const [analyticsSummary, setAnalyticsSummary] = useState<any>(null);
  const [analyticsPeakHours, setAnalyticsPeakHours] = useState<any>(null);
  const [analyticsFeatureUsage, setAnalyticsFeatureUsage] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // Backups
  const [backupStatus, setBackupStatus] = useState<any>(null);
  const [backupRunning, setBackupRunning] = useState(false);
  const [uploadBackupRunning, setUploadBackupRunning] = useState(false);
  const [backupRunResult, setBackupRunResult] = useState<string | null>(null);
  const [uploadBackupRunResult, setUploadBackupRunResult] = useState<string | null>(null);

  // User detail expansion
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [userActivity, setUserActivity] = useState<Record<number, any>>({});
  const [resetLinks, setResetLinks] = useState<Record<number, { link: string; expiresAt: string }>>({});
  const [generatingReset, setGeneratingReset] = useState<number | null>(null);

  function errorMessage(e: any, fallback: string): string {
    return e?.message || fallback;
  }

  function clearTabError(key: string) {
    setTabError(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function setLoadError(key: string, message: string) {
    setTabError(prev => ({ ...prev, [key]: message }));
  }

  useEffect(() => {
    if (tab === 'rss') loadRss();
    else if (tab === 'servers') loadServers();
    else if (tab === 'auth-logs') loadAuthEvents();
    else if (tab === 'health') loadHealth();
    else if (tab === 'analytics') loadAnalytics();
    else if (tab === 'backups') loadBackupStatus();
    else loadData();
    loadStats();
  }, [tab, reportFilter, userPage, userLimit, userSearch, userRoleFilter, authEventPage, authEventLimit, authEventType, authEventSuccess]);

  async function loadStats() { try { const r = await api.get<any>('/admin/stats'); setAdminStats(r); } catch (e) {} }

  async function loadUsers() {
    setUsersLoading(true);
    try {
      const r = await api.getUsers({ q: userSearch, role: userRoleFilter, page: userPage, limit: userLimit });
      setUsers(r.users);
      setUserTotal(r.total);
      setUserTotalPages(r.totalPages || 1);
      setActiveAdminTotal(r.activeAdminCount ?? 0);
      clearTabError('users');
    } catch (e: any) {
      console.error(e);
      setLoadError('users', errorMessage(e, 'Could not load users.'));
    } finally {
      setUsersLoading(false);
    }
  }

  async function loadData() {
    try {
      if (tab === 'users') { await loadUsers(); return; }
      if (tab === 'posts') { const r = await api.getAdminPosts(); setPosts(r.posts); }
      if (tab === 'reports') { await loadReports(reportFilter); }
      clearTabError(tab);
    } catch (e: any) {
      console.error(e);
      setLoadError(tab, errorMessage(e, `Could not load ${tab}.`));
    }
  }

  async function loadReports(filter: ReportFilter = reportFilter) {
    const qs = filter === 'all' ? '' : `?status=${filter}`;
    const r = await api.get<any>(`/admin/reports${qs}`);
    setReports(r.reports);
  }

  async function loadRss() {
    try {
      const r = await api.get<any>('/admin/rss/sources');
      setRssSources(r.sources);
      clearTabError('rss');
    } catch (e: any) { console.error(e); setLoadError('rss', errorMessage(e, 'Could not load RSS sources.')); }
  }

  async function addRssSource(e: React.FormEvent) {
    e.preventDefault();
    if (!rssName || !rssUrl) return;
    try {
      await api.post('/admin/rss/sources', { name: rssName, url: rssUrl, homepageUrl: rssHomepage, category: rssCategory });
      setRssName(''); setRssUrl(''); setRssHomepage(''); setRssCategory('general');
      loadRss();
    } catch (err: any) { console.error(err); setLoadError('rss', errorMessage(err, 'Could not add RSS source.')); }
  }

  async function toggleSource(id: number, active: boolean) {
    try {
      const r = await fetch(`/api/admin/rss/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ is_active: active ? 0 : 1 }),
      });
      if (r.ok) loadRss();
    } catch (e: any) { console.error(e); setLoadError('rss', errorMessage(e, 'Could not update RSS source.')); }
  }

  async function fetchSource(id: number) {
    try {
      const r = await api.post<any>(`/admin/rss/sources/${id}/fetch`);
      setRssFetchResult(r);
      loadRss();
    } catch (e: any) { console.error(e); setLoadError('rss', errorMessage(e, 'Could not fetch RSS source.')); }
  }

  async function fetchAll() {
    setFetchingAll(true);
    setRssFetchResult(null);
    try {
      const r = await api.post<any>('/admin/rss/fetch-all');
      setRssFetchResult({ batch: r });
      loadRss();
    } catch (e: any) { console.error(e); setLoadError('rss', errorMessage(e, 'Could not repopulate World Feed.')); }
    setFetchingAll(false);
  }

  async function loadServers() {
    try {
      const r = await api.get<any>('/admin/game-servers');
      setServerList(r.servers);
      clearTabError('servers');
    } catch (e: any) { console.error(e); setLoadError('servers', errorMessage(e, 'Could not load game servers.')); }
  }

  async function loadAuthEvents() {
    setAuthEventsLoading(true);
    try {
      const params: any = {};
      if (authEventType) params.eventType = authEventType;
      if (authEventSuccess !== '') params.success = authEventSuccess;
      params.page = authEventPage;
      params.limit = authEventLimit;
      const r = await api.getAuthEvents(params);
      setAuthEvents(r.events);
      setAuthEventTotal(r.total);
      setAuthEventTotalPages(r.totalPages || 1);
      clearTabError('auth-logs');
    } catch (e: any) { console.error(e); setLoadError('auth-logs', errorMessage(e, 'Could not load auth logs.')); }
    setAuthEventsLoading(false);
  }

  async function loadHealth() {
    try { const r = await api.getSystemHealth(); setSystemHealth(r); clearTabError('health'); } catch (e: any) { console.error(e); setLoadError('health', errorMessage(e, 'Could not load system health.')); }
  }

  async function loadUserActivity(userId: number) {
    if (userActivity[userId]) { setExpandedUser(prev => prev === userId ? null : userId); return; }
    try {
      const r = await api.getUserActivity(userId);
      setUserActivity(prev => ({ ...prev, [userId]: r }));
      setExpandedUser(userId);
    } catch (e: any) { console.error(e); setLoadError('users', errorMessage(e, 'Could not load user details.')); }
  }

  async function generateResetLink(userId: number) {
    setGeneratingReset(userId);
    try {
      const r = await api.generatePasswordResetToken(userId);
      setResetLinks(prev => ({ ...prev, [userId]: { link: r.resetLink, expiresAt: r.expiresAt } }));
    } catch (e: any) { alert(e.message || 'Could not generate reset link.'); }
    setGeneratingReset(null);
  }

  async function loadBackupStatus() {
    try { const r = await api.getBackupStatus(); setBackupStatus(r); clearTabError('backups'); } catch (e: any) { console.error(e); setLoadError('backups', errorMessage(e, 'Could not load backup status.')); }
  }

  async function runBackupNow() {
    if (!confirm('Run a database backup now? This typically takes a few seconds.')) return;
    setBackupRunning(true);
    setBackupRunResult(null);
    try {
      const r = await api.runBackup();
      if (r.ok) {
        setBackupRunResult(`✅ Done (${r.durationMs}ms)\n\n${r.output}`);
        await loadBackupStatus(); // refresh status card
      } else {
        setBackupRunResult(`❌ Failed: ${r.error}\n\n${r.output || ''}`);
      }
    } catch (e: any) {
      setBackupRunResult(`❌ Request error: ${e.message || 'Unknown'}`);
    }
    setBackupRunning(false);
  }

  async function runUploadBackupNow() {
    if (!confirm('Run an uploads/media backup now? This archives the uploads directory without deleting live files.')) return;
    setUploadBackupRunning(true);
    setUploadBackupRunResult(null);
    try {
      const r = await api.runUploadBackup();
      if (r.ok) {
        const latest = r.latestBackup;
        setUploadBackupRunResult(`✅ Done (${r.durationMs}ms)${latest ? `\n${latest.filename} (${formatBytes(latest.sizeBytes)})` : ''}`);
        await loadBackupStatus();
      } else {
        setUploadBackupRunResult(`❌ Failed: ${r.error || 'Upload backup failed.'}`);
      }
    } catch (e: any) {
      setUploadBackupRunResult(`❌ Request error: ${e.message || 'Unknown'}`);
    }
    setUploadBackupRunning(false);
  }

  async function addServer(e: React.FormEvent) {
    e.preventDefault();
    if (!srvForm.gameId || !srvForm.name) return;
    try {
      await fetch('/api/admin/game-servers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(srvForm) });
      setSrvForm({ gameId: '', name: '', connection_host: '', connection_port: '', platform: '', status: 'online', max_players: '', description: '', join_instructions: '' });
      loadServers();
    } catch (e: any) { console.error(e); setLoadError('servers', errorMessage(e, 'Could not add game server.')); }
  }

  async function toggleServerActive(id: number, active: boolean) {
    try {
      await fetch(`/api/admin/game-servers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ is_active: active ? 0 : 1 }) });
      loadServers();
    } catch (e: any) { console.error(e); setLoadError('servers', errorMessage(e, 'Could not update game server.')); }
  }

  async function deleteServer(id: number) {
    if (!confirm('Delete this server?')) return;
    try {
      await fetch(`/api/admin/game-servers/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      loadServers();
    } catch (e: any) { console.error(e); setLoadError('servers', errorMessage(e, 'Could not delete game server.')); }
  }

  async function updateReportStatus(id: number, status: 'dismissed' | 'resolved', adminNote: string) {
    const res = await fetch(`/api/admin/reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify({ status, adminNote }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not update report.');
    }
  }

  async function reviewReport(report: any, status: 'dismissed' | 'resolved') {
    setReportActionError('');
    try {
      await updateReportStatus(report.id, status, reportNotes[report.id] || '');
      await loadReports(reportFilter);
      loadStats();
    } catch (e: any) { console.error(e); setReportActionError(e.message || 'Could not update report.'); }
  }

  async function changeRole(id: number, role: string) {
    setRoleMsg('');
    const target = users.find(u => u.id === id);
    if (target && isSelfAdmin(target) && role !== 'admin') {
      setRoleMsg('You cannot demote your own admin account.');
      return;
    }
    if (target && isLastActiveAdmin(target) && role !== 'admin') {
      setRoleMsg('Cannot demote the last active admin.');
      return;
    }
    try {
      const r = await fetch(`/api/admin/users/${id}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ role }),
      });
      const data = await r.json();
      if (!r.ok) { setRoleMsg(data.error || 'Failed'); return; }
      setUsers(prev => prev.map(u => u.id === id ? { ...u, role: data.role } : u));
      setRoleMsg(`Role updated to ${role}`);
    } catch (e: any) { console.error(e); setRoleMsg(errorMessage(e, 'Could not change role.')); }
  }

  async function toggleBan(id: number, banned: boolean) {
    setRoleMsg('');
    const target = users.find(u => u.id === id);
    if (target && isSelfAdmin(target) && !banned) {
      setRoleMsg('You cannot ban your own admin account.');
      return;
    }
    if (target && isLastActiveAdmin(target) && !banned) {
      setRoleMsg('Cannot ban the last active admin.');
      return;
    }
    const action = banned ? 'Unban' : 'Ban';
    if (!confirm(`${action} @${target?.username}?`)) return;
    try {
      await (banned ? api.unbanUser(id) : api.banUser(id));
      setUsers(prev => prev.map(u => u.id === id ? { ...u, banned: banned ? 0 : 1 } : u));
    } catch (e: any) { console.error(e); setRoleMsg(e.message || 'Could not update ban status.'); }
  }

  async function toggleHide(id: number, hidden: boolean) {
    try {
      await (hidden ? api.unhidePost(id) : api.hidePost(id));
      setPosts(prev => prev.map(p => p.id === id ? { ...p, hidden: hidden ? 0 : 1 } : p));
    } catch (e) { console.error(e); }
  }

  async function verifyUser(id: number) {
    try {
      await fetch(`/api/admin/users/${id}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_verified: 1 } : u));
    } catch (e: any) { console.error(e); setRoleMsg(errorMessage(e, 'Could not verify user.')); }
  }

  async function unverifyUser(id: number) {
    try {
      await fetch(`/api/admin/users/${id}/unverify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_verified: 0 } : u));
    } catch (e: any) { console.error(e); setRoleMsg(errorMessage(e, 'Could not unverify user.')); }
  }

  async function deleteUser(u: any) {
    if (isLastActiveAdmin(u)) {
      alert('Cannot delete the last active admin.');
      return;
    }
    if (!confirm(`Delete @${u.username}? This removes the user and their related content. This cannot be undone.`)) return;
    try {
      await api.deleteUser(u.id);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      loadStats();
    } catch (e: any) { alert(e.message || 'Could not delete user.'); }
  }

  async function loadAnalytics() {
    setAnalyticsLoading(true);
    try {
      const [summary, peak, feature] = await Promise.all([
        api.getAnalyticsSummary(),
        api.getAnalyticsPeakHours(),
        api.getAnalyticsFeatureUsage(),
      ]);
      setAnalyticsSummary(summary);
      setAnalyticsPeakHours(peak);
      setAnalyticsFeatureUsage(feature);
      clearTabError('analytics');
    } catch (e: any) { console.error(e); setLoadError('analytics', errorMessage(e, 'Could not load analytics.')); }
    finally { setAnalyticsLoading(false); }
  }

  function retryCurrentTab() {
    if (tab === 'rss') loadRss();
    else if (tab === 'servers') loadServers();
    else if (tab === 'auth-logs') loadAuthEvents();
    else if (tab === 'health') loadHealth();
    else if (tab === 'analytics') loadAnalytics();
    else if (tab === 'backups') loadBackupStatus();
    else loadData();
  }

  const currentUserId = Number(currentUser?.id ?? 0);
  const isSelfAdmin = (u: any) => Number(u.id) === currentUserId && u.role === 'admin';
  const isLastActiveAdmin = (u: any) => u.role === 'admin' && !u.banned && activeAdminTotal <= 1;
  const adminRoleChangeDisabled = (u: any) => isSelfAdmin(u) || isLastActiveAdmin(u);
  const adminRoleChangeTitle = (u: any) => {
    if (isSelfAdmin(u)) return 'You cannot demote your own admin account.';
    if (isLastActiveAdmin(u)) return 'Cannot demote the last active admin.';
    return undefined;
  };
  const adminBanDisabled = (u: any) => !u.banned && (isSelfAdmin(u) || isLastActiveAdmin(u));
  const adminBanTitle = (u: any) => {
    if (u.banned) return undefined;
    if (isSelfAdmin(u)) return 'You cannot ban your own admin account.';
    if (isLastActiveAdmin(u)) return 'Cannot ban the last active admin.';
    return undefined;
  };
  const currentTabError = tabError[tab];

  return (
    <div className="admin-page">
      <h2>🛡 Admin Dashboard</h2>
      <div className="admin-stats">
        <div className="admin-stat-card"><span className="admin-stat-num">{adminStats.totalUsers || 0}</span><span>Users</span></div>
        <div className="admin-stat-card warn"><span className="admin-stat-num">{adminStats.unverifiedUsers || 0}</span><span>Unverified</span></div>
        <div className="admin-stat-card danger"><span className="admin-stat-num">{adminStats.bannedUsers || 0}</span><span>Banned</span></div>
        <div className="admin-stat-card alert"><span className="admin-stat-num">{adminStats.openReports || 0}</span><span>Open Reports</span></div>
        <div className="admin-stat-card"><span className="admin-stat-num">{adminStats.activeRssSources || 0}</span><span>RSS Sources</span></div>
        <div className="admin-stat-card warn"><span className="admin-stat-num">{adminStats.hiddenPosts || 0}</span><span>Hidden Posts</span></div>
        <div className="admin-stat-card"><span className="admin-stat-num">{adminStats.gameCount || 0}</span><span>Games</span></div>
      </div>
      <div className="admin-tabs">
        <button className={`btn ${tab === 'users' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('users'); setRssFetchResult(null); }}>Users</button>
        <button className={`btn ${tab === 'posts' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('posts'); setRssFetchResult(null); }}>Posts</button>
        <button className={`btn ${tab === 'reports' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('reports'); setRssFetchResult(null); }}>Reports</button>
        <button className={`btn ${tab === 'rss' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('rss')}>RSS Sources</button>
        <button className={`btn ${tab === 'servers' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setTab('servers'); loadServers(); }}>Game Servers</button>
        <button className={`btn ${tab === 'auth-logs' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('auth-logs')}>Auth Logs</button>
        <button className={`btn ${tab === 'health' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('health')}>System Health</button>
        <button className={`btn ${tab === 'analytics' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('analytics')}>Analytics</button>
        <button className={`btn ${tab === 'backups' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('backups')}>Backups</button>
      </div>
      {currentTabError && (
        <div className="error-msg" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', margin: '10px 0 14px' }}>
          <span>{currentTabError}</span>
          <button className="btn btn-sm" onClick={retryCurrentTab}>Retry</button>
        </div>
      )}

      {/* Users tab */}
      {tab === 'users' && (
        <div>
          <div className="admin-user-filters" style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input className="input" placeholder="Search users..." value={userSearch}
              onChange={e => { setUserSearch(e.target.value); setUserPage(1); }} style={{ maxWidth: 220 }} />
            <select className="input" value={userRoleFilter} onChange={e => { setUserRoleFilter(e.target.value); setUserPage(1); }} style={{ width: 'auto' }}>
              <option value="">All roles</option>
              <option value="admin">Admin</option>
              <option value="mod">Mod</option>
              <option value="user">User</option>
            </select>
            <select className="input" value={userLimit} onChange={e => { setUserLimit(Number(e.target.value)); setUserPage(1); }} style={{ width: 'auto' }}>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
              <option value={200}>200 / page</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              {usersLoading ? 'Loading users...' : `${userTotal} user${userTotal !== 1 ? 's' : ''} found`}
            </span>
            <button className="btn btn-sm" disabled={userPage <= 1 || usersLoading} onClick={() => setUserPage(p => Math.max(1, p - 1))}>Previous</button>
            <span className="muted" style={{ fontSize: '0.82rem' }}>Page {userPage} of {userTotalPages}</span>
            <button className="btn btn-sm" disabled={userPage >= userTotalPages || usersLoading} onClick={() => setUserPage(p => p + 1)}>Next</button>
          </div>
          {roleMsg && <p className="muted" style={{ marginBottom: 8, color: 'var(--green)' }}>{roleMsg}</p>}
          <div className="admin-users-list">
            {users.length === 0 && !usersLoading ? <p className="muted">No users match the current filters.</p> : users.map(u => (
                <Fragment key={u.id}>
                <div className="admin-user-card">
                  <div className="admin-user-info">
                    <div className="avatar-placeholder" style={{ width: 36, height: 36, fontSize: '1rem' }}>{u.display_name?.[0] || '?'}</div>
                    <div>
                      <strong>{u.display_name}</strong> <span className="muted">@{u.username}</span>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>{u.email}</div>
                    </div>
                  </div>
                  <div className="admin-user-badges">
                    <span className={`admin-badge badge-${u.role}`}>{u.role}</span>
                    <span className={`admin-badge ${u.is_verified ? 'badge-verified' : 'badge-unverified'}`}>{u.is_verified ? '✅ Verified' : '⚠ Unverified'}</span>
                    <span className={`admin-badge ${u.banned ? 'badge-banned' : 'badge-active'}`}>{u.banned ? '🚫 Banned' : 'Active'}</span>
                    <span className="admin-badge badge-vis">{u.profile_visibility || 'public'}</span>
                  </div>
                  <div className="admin-user-actions">
                    <button className="btn btn-sm" onClick={() => {
                      if (expandedUser === u.id) { setExpandedUser(null); } else { loadUserActivity(u.id); }
                    }}>{expandedUser === u.id ? 'Close' : 'Details'}</button>
                    <select className="input" value={userRoleDraft[u.id] ?? u.role}
                      onChange={e => setUserRoleDraft(prev => ({ ...prev, [u.id]: e.target.value }))}
                      style={{ width: 90, padding: '4px 8px', fontSize: '0.8rem' }}
                      disabled={adminRoleChangeDisabled(u)}
                      title={adminRoleChangeTitle(u)}>
                      <option value="user">User</option>
                      <option value="mod">Mod</option>
                      <option value="admin">Admin</option>
                    </select>
                    {userRoleDraft[u.id] && userRoleDraft[u.id] !== u.role && !adminRoleChangeDisabled(u) && (
                      <button className="btn btn-sm" onClick={() => {
                        const next = userRoleDraft[u.id];
                        if (!confirm(`Change @${u.username}'s role from ${u.role} → ${next}?`)) return;
                        changeRole(u.id, next);
                        setUserRoleDraft(prev => { const d = { ...prev }; delete d[u.id]; return d; });
                      }}>Apply</button>
                    )}
                    {u.role !== 'admin' && (u.is_verified ? (
                      <button className="btn btn-sm" onClick={() => unverifyUser(u.id)}>Unverify</button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => verifyUser(u.id)}>Verify</button>
                    ))}
                    <button className="btn btn-sm" disabled={adminBanDisabled(u)} title={adminBanTitle(u)} onClick={() => toggleBan(u.id, !!u.banned)}>{u.banned ? 'Unban' : 'Ban'}</button>
                    {u.id !== currentUser?.id && (
                      <button className="btn btn-sm btn-danger" disabled={isLastActiveAdmin(u)} title={isLastActiveAdmin(u) ? 'Cannot delete the last active admin.' : undefined} onClick={() => deleteUser(u)}>Delete</button>
                    )}
                    {isSelfAdmin(u) && !u.banned && <span className="muted" style={{ fontSize: '0.76rem' }}>You cannot ban your own admin account.</span>}
                    {isLastActiveAdmin(u) && !isSelfAdmin(u) && <span className="muted" style={{ fontSize: '0.76rem' }}>Cannot remove the last active admin.</span>}
                  </div>
                </div>
                {expandedUser === u.id && (
                  <UserDetailPanel
                    act={userActivity[u.id]}
                    resetLink={resetLinks[u.id]}
                    generatingReset={generatingReset === u.id}
                    onGenerateReset={() => generateResetLink(u.id)}
                    onDismissReset={() => setResetLinks(prev => { const d = {...prev}; delete d[u.id]; return d; })}
                    onCopyLink={() => navigator.clipboard.writeText(resetLinks[u.id]?.link || '')}
                  />
                )}
                </Fragment>
              ))}
          </div>
        </div>
      )}

      {/* Posts tab */}
      {tab === 'posts' && (
        <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>ID</th><th>User</th><th>Content</th><th>Hidden</th><th>Action</th></tr></thead>
          <tbody>{posts.map(p => (
            <tr key={p.id}><td>{p.id}</td><td>@{p.username}</td><td>{p.content?.slice(0, 80)}</td>
              <td>{p.hidden ? '🙈 Hidden' : '👁 Visible'}</td>
              <td><button className="btn btn-sm" onClick={() => toggleHide(p.id, !!p.hidden)}>{p.hidden ? 'Show' : 'Hide'}</button></td></tr>
          ))}</tbody>
        </table></div>
      )}

      {/* Reports tab */}
      {tab === 'reports' && (
        <div>
          <div className="report-filters">
            {REPORT_FILTERS.map(s => (
              <button key={s} className={`btn btn-sm ${reportFilter === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setReportFilter(s)}>
                {REPORT_FILTER_LABELS[s]}
              </button>
            ))}
          </div>
          {reportActionError && <p className="error-msg">{reportActionError}</p>}
          {reports.length === 0 ? <p className="muted">No {reportFilter} reports.</p> : (
            reports.map(r => (
              <div key={r.id} className={`report-card ${r.status !== 'open' ? 'report-card--resolved' : ''}`}>
                <div className="report-card-header">
                  <strong className="report-title">Report #{r.id}</strong>
                  <span className={`admin-badge ${r.status === 'open' ? 'badge-unverified' : r.status === 'resolved' ? 'badge-banned' : 'badge-verified'}`}>
                    {REPORT_STATUS_LABELS[r.status] || 'Open'}
                  </span>
                </div>

                <div className="report-meta-list">
                  <div className="report-meta-row"><span className="report-meta-key">Type</span><span>{r.post_parent_id ? 'Comment' : 'Post'}</span></div>
                  <div className="report-meta-row"><span className="report-meta-key">Reporter</span><span>@{r.reporter_name}</span></div>
                  <div className="report-meta-row"><span className="report-meta-key">Author</span><span>{r.post_author_name ? `@${r.post_author_name}` : <em className="muted">Unknown</em>}</span></div>
                  <div className="report-meta-row"><span className="report-meta-key">Reason</span><span>{r.reason || 'Unknown'}</span></div>
                  <div className="report-meta-row"><span className="report-meta-key">Submitted</span><span>{r.created_at ? new Date(`${r.created_at}Z`).toLocaleString() : 'Unknown'}</span></div>
                </div>

                <div className="report-section">
                  <div className="report-section-label">Explanation</div>
                  <p>{r.report_details || 'No explanation provided.'}</p>
                </div>

                <div className="report-section">
                  <div className="report-section-label">Reported content</div>
                  <p className="report-content-text">{r.post_content ? `"${r.post_content.slice(0, 240)}${r.post_content.length > 240 ? '…' : ''}"` : <em>Content unavailable.</em>}</p>
                  {r.post_hidden ? <span className="report-hidden-badge">Hidden</span> : null}
                </div>

                {r.status === 'open' ? (
                  <label className="report-admin-note-field">
                    Admin note
                    <textarea
                      className="input"
                      rows={2}
                      placeholder="Optional note about this decision"
                      value={reportNotes[r.id] || ''}
                      onChange={e => setReportNotes(prev => ({ ...prev, [r.id]: e.target.value }))}
                    />
                  </label>
                ) : r.admin_note ? (
                  <div className="report-section">
                    <div className="report-section-label">Admin note</div>
                    <p>{r.admin_note}</p>
                  </div>
                ) : null}

                {r.status === 'open' && (
                  <div className="report-card-actions">
                    <button className="btn btn-sm report-btn-approve" onClick={() => reviewReport(r, 'dismissed')}>Dismiss Report</button>
                    <button className="btn btn-sm report-btn-delete" onClick={() => {
                      if (!confirm('Hide this content and mark the report resolved? The post will be hidden from public view.')) return;
                      reviewReport(r, 'resolved');
                    }}>Hide & Resolve</button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* RSS Sources tab */}
      {tab === 'rss' && (
        <div className="rss-admin">
          <h3>Add RSS Source</h3>
          <form className="rss-add-form" onSubmit={addRssSource}>
            <input className="input" placeholder="Source Name" value={rssName} onChange={e => setRssName(e.target.value)} required />
            <input className="input" placeholder="RSS Feed URL" value={rssUrl} onChange={e => setRssUrl(e.target.value)} required />
            <input className="input" placeholder="Homepage URL (optional)" value={rssHomepage} onChange={e => setRssHomepage(e.target.value)} />
            <input className="input" placeholder="Category (e.g. tech, news)" value={rssCategory} onChange={e => setRssCategory(e.target.value)} />
            <button className="btn btn-primary">Add Source</button>
          </form>

          <div style={{ margin: '16px 0' }}>
            <button className="btn btn-primary" onClick={fetchAll} disabled={fetchingAll}>
              {fetchingAll ? 'Fetching… (may take a minute)' : '🔄 Repopulate World Feed'}
            </button>
            <span className="muted" style={{ marginLeft: 10, fontSize: '0.82rem' }}>Fetches all active sources and inserts new items.</span>
          </div>

          {rssFetchResult && (
            <div className="rss-fetch-result" style={{ margin: '12px 0', padding: 12, background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)' }}>
              <strong>Repopulate result:</strong>
              {rssFetchResult.batch ? (
                <table style={{ marginTop: 8, width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead><tr style={{ textAlign: 'left' }}><th style={{ paddingRight: 12 }}>Source</th><th style={{ paddingRight: 12 }}>Category</th><th style={{ paddingRight: 12 }}>New</th><th style={{ paddingRight: 12 }}>Dupes</th><th>Status</th></tr></thead>
                  <tbody>{rssFetchResult.batch.map((r: any) => (
                    <tr key={r.sourceId} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ paddingRight: 12, paddingTop: 4 }}>{r.sourceName}</td>
                      <td className="muted" style={{ paddingRight: 12 }}>{r.category || '—'}</td>
                      <td style={{ paddingRight: 12, color: r.itemsInserted > 0 ? 'var(--green)' : undefined }}>{r.itemsInserted}</td>
                      <td className="muted" style={{ paddingRight: 12 }}>{r.duplicatesSkipped}</td>
                      <td>{r.error ? <span style={{ color: 'var(--danger)' }}>⚠ {r.error}</span> : '✓'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ) : (
                <div style={{ marginTop: 6 }}>{rssFetchResult.sourceName}: {rssFetchResult.itemsInserted} new, {rssFetchResult.duplicatesSkipped} dupes{rssFetchResult.error ? ` — ⚠ ${rssFetchResult.error}` : ' ✓'}</div>
              )}
            </div>
          )}

          <h3>Sources ({rssSources.length})</h3>
          {/* Category filter */}
          {(() => {
            const cats = [...new Set(rssSources.map(s => s.category))].sort();
            const allCounts: Record<string, number> = {};
            rssSources.forEach(s => { allCounts[s.category] = (allCounts[s.category] || 0) + 1; });
            return (
              <div className="filter-bar" style={{ marginBottom: 8 }}>
                <button className={`btn btn-sm ${!rssCatFilter ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRssCatFilter('')}>All ({rssSources.length})</button>
                {cats.map(c => (
                  <button key={c} className={`btn btn-sm ${rssCatFilter === c ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRssCatFilter(c)}>
                    {c} ({allCounts[c]})
                  </button>
                ))}
              </div>
            );
          })()}
          <div className="admin-table-wrap"><table className="admin-table">
            <thead><tr><th>Name</th><th>URL</th><th>Category</th><th>Active</th><th>Last Fetched</th><th>Actions</th></tr></thead>
            <tbody>{rssSources.filter(s => !rssCatFilter || s.category === rssCatFilter).map(s => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.url}</td>
                <td>{s.category}</td>
                <td>{s.is_active ? '✅' : '❌'}</td>
                <td className="muted">{s.last_fetched_at || 'never'}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => fetchSource(s.id)}>Fetch</button>
                  <button className="btn btn-sm" onClick={() => toggleSource(s.id, !!s.is_active)}>{s.is_active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {/* Game Servers tab */}
      {tab === 'servers' && (
        <div>
          <h3>Add Server</h3>
          <form className="rss-add-form" onSubmit={addServer}>
            <input className="input" placeholder="Game ID" value={srvForm.gameId} onChange={e => setSrvForm({ ...srvForm, gameId: e.target.value })} required />
            <input className="input" placeholder="Server Name" value={srvForm.name} onChange={e => setSrvForm({ ...srvForm, name: e.target.value })} required />
            <input className="input" placeholder="Host/IP" value={srvForm.connection_host} onChange={e => setSrvForm({ ...srvForm, connection_host: e.target.value })} />
            <input className="input" placeholder="Port" value={srvForm.connection_port} onChange={e => setSrvForm({ ...srvForm, connection_port: e.target.value })} style={{ width: 100 }} />
            <input className="input" placeholder="Platform" value={srvForm.platform} onChange={e => setSrvForm({ ...srvForm, platform: e.target.value })} style={{ width: 120 }} />
            <button className="btn btn-primary">Add Server</button>
          </form>

          <h3 style={{ marginTop: 20 }}>Servers ({serverList.length})</h3>
          <div className="admin-table-wrap"><table className="admin-table">
            <thead><tr><th>Game</th><th>Name</th><th>Host</th><th>Status</th><th>Players</th><th>Active</th><th>Actions</th></tr></thead>
            <tbody>{serverList.map((s: any) => (
              <tr key={s.id}>
                <td>{s.game_name}</td>
                <td><strong>{s.name}</strong></td>
                <td className="muted">{s.connection_host}{s.connection_port ? `:${s.connection_port}` : ''}</td>
                <td>{s.status}</td>
                <td>{s.current_players}/{s.max_players || '?'}</td>
                <td>{s.is_active ? '✅' : '❌'}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => toggleServerActive(s.id, !!s.is_active)}>{s.is_active ? 'Deactivate' : 'Activate'}</button>
                  <button className="btn btn-sm" onClick={() => deleteServer(s.id)}>Delete</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {/* Auth Logs tab */}
      {tab === 'auth-logs' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="input" value={authEventType} onChange={e => { setAuthEventType(e.target.value); setAuthEventPage(1); }} style={{ width: 'auto' }}>
              <option value="">All event types</option>
              {Object.entries(EVENT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className="input" value={authEventSuccess} onChange={e => { setAuthEventSuccess(e.target.value); setAuthEventPage(1); }} style={{ width: 'auto' }}>
              <option value="">All outcomes</option>
              <option value="1">Success only</option>
              <option value="0">Failures only</option>
            </select>
            <select className="input" value={authEventLimit} onChange={e => { setAuthEventLimit(Number(e.target.value)); setAuthEventPage(1); }} style={{ width: 'auto' }}>
              <option value={100}>100 / page</option>
              <option value={200}>200 / page</option>
              <option value={300}>300 / page</option>
            </select>
            <button className="btn btn-sm btn-ghost" onClick={loadAuthEvents} disabled={authEventsLoading}>
              {authEventsLoading ? 'Loading…' : '↻ Refresh'}
            </button>
            <span className="muted" style={{ fontSize: '0.82rem' }}>{authEvents.length} of {authEventTotal} events</span>
            <button className="btn btn-sm" disabled={authEventPage <= 1 || authEventsLoading} onClick={() => setAuthEventPage(p => Math.max(1, p - 1))}>Previous</button>
            <span className="muted" style={{ fontSize: '0.82rem' }}>Page {authEventPage} of {authEventTotalPages}</span>
            <button className="btn btn-sm" disabled={authEventPage >= authEventTotalPages || authEventsLoading} onClick={() => setAuthEventPage(p => p + 1)}>Next</button>
          </div>
          {authEvents.length === 0 && !authEventsLoading && <p className="muted">No events match the current filter.</p>}
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Event</th><th>User</th><th>Result</th><th>IP</th><th>User Agent</th><th>When</th></tr></thead>
              <tbody>{authEvents.map(ev => (
                <tr key={ev.id} style={{ opacity: ev.success ? 1 : 0.85 }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{EVENT_TYPE_LABELS[ev.event_type] || ev.event_type}</td>
                  <td>{ev.username ? `@${ev.username}` : ev.target_user_username ? `→@${ev.target_user_username}` : <em className="muted">—</em>}
                    {ev.admin_actor_username && <span className="muted" style={{ fontSize: '0.78rem' }}> (by @{ev.admin_actor_username})</span>}
                  </td>
                  <td style={{ color: ev.success ? 'var(--green)' : 'var(--danger)', whiteSpace: 'nowrap' }}>
                    {ev.success ? '✓ OK' : `✗ ${ev.reason || 'fail'}`}
                  </td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{ev.ip_address || '—'}</td>
                  <td className="muted" style={{ fontSize: '0.75rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ev.user_agent}>
                    {ev.user_agent?.slice(0, 60) || '—'}
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{ev.created_at?.slice(0,16).replace('T',' ')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* System Health tab */}
      {tab === 'health' && (
        <div style={{ maxWidth: 600 }}>
          {!systemHealth ? (
            <p className="muted">Loading…</p>
          ) : (
            <>
              <div style={{ display: 'grid', gap: 10, marginBottom: 24 }}>
                {([
                  ['Status', systemHealth.status === 'ok' ? '✅ OK' : '⚠ Degraded'],
                  ['Environment', systemHealth.nodeEnv],
                  ['App version', systemHealth.appVersion],
                  ['Database', systemHealth.dbReachable ? '✅ Reachable' : '❌ Unreachable'],
                  ['Uploads path', systemHealth.uploadsPathOk ? '✅ Exists' : '❌ Missing'],
                  ['Google OAuth', systemHealth.googleOAuth],
                  ['Steam OAuth', systemHealth.steamOAuth],
                  ['Uptime', `${Math.floor(systemHealth.uptimeSeconds / 60)}m ${systemHealth.uptimeSeconds % 60}s`],
                  ['Total users', systemHealth.totalUsers],
                  ['Open reports', systemHealth.openReports],
                  ['Auth events (24h)', systemHealth.authEventsLast24h],
                ] as [string, any][]).map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                    <span className="muted" style={{ minWidth: 160, fontSize: '0.88rem' }}>{label}</span>
                    <strong style={{ fontSize: '0.88rem' }}>{String(value)}</strong>
                  </div>
                ))}
              </div>
              <button className="btn btn-sm btn-ghost" onClick={loadHealth}>↻ Refresh</button>
            </>
          )}
        </div>
      )}

      {/* Analytics tab */}
      {tab === 'analytics' && (
        <div>
          {analyticsLoading ? (
            <p className="muted">Loading analytics…</p>
          ) : (
            <>
              {analyticsSummary && (
                <>
                  <h3 style={{ marginBottom: 12 }}>Overview</h3>
                  <p className="muted" style={{ marginBottom: 8, fontSize: '0.82rem' }}>
                    {analyticsSummary.recentlyActive} user{analyticsSummary.recentlyActive !== 1 ? 's' : ''} active in the last 15 minutes
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 10, marginBottom: 24 }}>
                    {([
                      ['Active Users Today', analyticsSummary.activeUsersToday],
                      ['Active Users 7d', analyticsSummary.activeUsers7d],
                      ['Active Users 30d', analyticsSummary.activeUsers30d],
                      ['Page Views Today', analyticsSummary.pageViewsToday],
                      ['Page Views 7d', analyticsSummary.pageViews7d],
                      ['Page Views 30d', analyticsSummary.pageViews30d],
                      ['Posts Today', analyticsSummary.postsToday],
                      ['Comments Today', analyticsSummary.commentsToday],
                      ['Likes Today', analyticsSummary.likesToday],
                      ['Login OK Today', analyticsSummary.loginSuccessToday],
                      ['Login Fail Today', analyticsSummary.loginFailToday],
                      ['Uploads OK Today', analyticsSummary.uploadSuccessToday],
                      ['Uploads Fail Today', analyticsSummary.uploadFailToday],
                    ] as [string, number][]).map(([label, val]) => (
                      <div key={label} className="admin-stat-card" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '10px 14px' }}>
                        <span className="admin-stat-num" style={{ fontSize: '1.5rem' }}>{val ?? 0}</span>
                        <span className="muted" style={{ fontSize: '0.78rem' }}>{label}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {analyticsPeakHours && (
                <>
                  <h3 style={{ marginBottom: 8 }}>Peak Hours (last 7 days)</h3>
                  <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 10 }}>
                    Based on aggregate activity in the last 7 days. These are estimates only.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                    <div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                        <thead>
                          <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                            <th style={{ paddingBottom: 6, paddingRight: 16 }}>Hour (UTC)</th>
                            <th style={{ paddingBottom: 6 }}>Events</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(analyticsPeakHours.peakHours || []).slice(0, 10).map((r: any) => (
                            <tr key={r.hour} style={{ borderTop: '1px solid var(--border)' }}>
                              <td style={{ padding: '5px 16px 5px 0' }}>{String(r.hour).padStart(2, '0')}:00</td>
                              <td style={{ padding: '5px 0' }}>{r.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <div style={{ marginBottom: 16 }}>
                        <strong style={{ display: 'block', marginBottom: 6, fontSize: '0.88rem' }}>Suggested Announcement Windows</strong>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem' }}>
                          {(analyticsPeakHours.suggestedAnnouncementWindows || []).map((w: string) => (
                            <li key={w} style={{ marginBottom: 4 }}>{w} UTC</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <strong style={{ display: 'block', marginBottom: 6, fontSize: '0.88rem' }}>Quiet Maintenance Windows</strong>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem' }}>
                          {(analyticsPeakHours.quietWindows || []).map((w: string) => (
                            <li key={w} style={{ marginBottom: 4 }}>{w} UTC</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {analyticsFeatureUsage && (
                <>
                  <h3 style={{ marginBottom: 8 }}>Feature Area Usage (last 30 days)</h3>
                  <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem', marginBottom: 16, minWidth: 280 }}>
                    <thead>
                      <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                        <th style={{ paddingBottom: 6, paddingRight: 32 }}>Feature Area</th>
                        <th style={{ paddingBottom: 6 }}>Events</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(analyticsFeatureUsage.featureAreas || []).map((r: any) => (
                        <tr key={r.area} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '5px 32px 5px 0', textTransform: 'capitalize' }}>{r.area}</td>
                          <td style={{ padding: '5px 0' }}>{r.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <button className="btn btn-sm btn-ghost" onClick={loadAnalytics}>↻ Refresh</button>
            </>
          )}
        </div>
      )}

      {/* Backups tab */}
      {tab === 'backups' && (
        <div style={{ maxWidth: 820 }}>
          {!backupStatus ? (
            <p className="muted">Loading…</p>
          ) : (() => {
            const health = backupHealthStatus(backupStatus);
            const lb = backupStatus.latestBackup;
            const uploads = backupStatus.uploadBackups || {};
            const ulb = uploads.latestBackup;
            return (
              <>
                {/* ── Status banner ── */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '10px 16px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '1rem', fontWeight: 700, color: health.color }}>{health.label}</span>
                  <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={loadBackupStatus}>↻ Refresh</button>
                </div>

                {/* ── Database backups ── */}
                <h3 style={{ marginBottom: 10 }}>Database Backups</h3>
                <div style={{ display: 'grid', gap: 10, marginBottom: 20 }}>
                  {([
                    ['Backup directory',  backupStatus.backupDir],
                    ['Backup count',      `${backupStatus.backupCount} file${backupStatus.backupCount !== 1 ? 's' : ''}`],
                    ['Total stored',      formatBytes(backupStatus.totalSizeBytes)],
                    ['Retention policy',  `${backupStatus.retentionDays} days`],
                    ...(lb ? [
                      ['Latest backup',    lb.filename],
                      ['Latest size',      formatBytes(lb.sizeBytes)],
                      ['Latest age',       formatBackupAge(lb.ageHours)],
                      ['Integrity check',  backupStatus.integrityCheck === 'ok'
                        ? '✅ ok'
                        : backupStatus.integrityCheck === 'failed'
                          ? '❌ FAILED — backup may be corrupt'
                          : '— unavailable'],
                    ] as [string, string][] : [
                      ['Latest backup',    '⚠ None found'],
                    ] as [string, string][]),
                    ['Timer status',      backupStatus.timerActive === 'active'
                      ? '✅ active'
                      : backupStatus.timerActive === 'inactive'
                        ? '⚠ inactive — enable with: sudo systemctl enable --now refugecloud-db-backup.timer'
                        : `— ${backupStatus.timerActive}`],
                    ['Next scheduled run', backupStatus.nextScheduledRun],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                      <span className="muted" style={{ minWidth: 170, fontSize: '0.88rem', flexShrink: 0 }}>{label}</span>
                      <span style={{ fontSize: '0.88rem', wordBreak: 'break-all' }}>{value}</span>
                    </div>
                  ))}
                </div>

                {/* ── Last service log ── */}
                {backupStatus.lastServiceLog && backupStatus.lastServiceLog !== 'unavailable' && (
                  <div style={{ marginBottom: 20 }}>
                    <strong style={{ display: 'block', marginBottom: 6, fontSize: '0.88rem' }}>Last service log</strong>
                    <pre style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: '0.75rem', overflowX: 'auto', maxHeight: 180, overflowY: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {backupStatus.lastServiceLog}
                    </pre>
                  </div>
                )}

                {/* ── Run database backup now ── */}
                <div style={{ marginBottom: 24 }}>
                  <button className="btn btn-primary" disabled={backupRunning} onClick={runBackupNow}>
                    {backupRunning ? '⏳ Running backup…' : '💾 Run Database Backup Now'}
                  </button>
                  <span className="muted" style={{ marginLeft: 12, fontSize: '0.82rem' }}>
                    Runs <code>scripts/backup-db.sh</code> — safe, no service restart needed.
                  </span>
                  {backupRunResult && (
                    <pre style={{ marginTop: 10, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: '0.75rem', overflowX: 'auto', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {backupRunResult}
                    </pre>
                  )}
                </div>

                {/* ── Uploads backups ── */}
                <h3 style={{ marginBottom: 10 }}>Uploads / Media Backups</h3>
                <div style={{ display: 'grid', gap: 10, marginBottom: 20 }}>
                  {([
                    ['Uploads covered', uploads.uploadsCovered ? '✅ Yes — local archive exists' : '⚠ No upload backup archive found yet'],
                    ['Uploads source', uploads.sourceDir || '/home/brock/social-site/uploads'],
                    ['Source exists', uploads.sourceDirExists ? '✅ yes' : '❌ missing'],
                    ['Source files', `${uploads.sourceFileCount ?? 0} file${(uploads.sourceFileCount ?? 0) !== 1 ? 's' : ''}`],
                    ['Source size', formatBytes(uploads.sourceSizeBytes ?? 0)],
                    ['Backup directory', uploads.backupDir || '/home/brock/backups/refugecloud-uploads'],
                    ['Backup count', `${uploads.backupCount ?? 0} archive${(uploads.backupCount ?? 0) !== 1 ? 's' : ''}`],
                    ['Backup stored', formatBytes(uploads.totalSizeBytes ?? 0)],
                    ['Retention policy', `${uploads.retentionDays ?? 14} days`],
                    ...(ulb ? [
                      ['Latest upload backup', ulb.filename],
                      ['Latest upload size', formatBytes(ulb.sizeBytes)],
                      ['Latest upload age', formatBackupAge(ulb.ageHours)],
                    ] as [string, string][] : [
                      ['Latest upload backup', '⚠ None found'],
                    ] as [string, string][]),
                    ['Timer', uploads.timerName || 'refugecloud-uploads-backup.timer'],
                    ['Service', uploads.serviceName || 'refugecloud-uploads-backup.service'],
                    ['Timer status', uploads.timerActive === 'active'
                      ? '✅ active'
                      : uploads.timerActive === 'inactive'
                        ? '⚠ inactive — install/enable only after review'
                        : `— ${uploads.timerActive || 'unavailable'}`],
                    ['Next scheduled run', uploads.nextScheduledRun || 'unavailable'],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                      <span className="muted" style={{ minWidth: 170, fontSize: '0.88rem', flexShrink: 0 }}>{label}</span>
                      <span style={{ fontSize: '0.88rem', wordBreak: 'break-all' }}>{value}</span>
                    </div>
                  ))}
                </div>

                <div style={{
                  background: 'var(--bg-card)',
                  border: `1px solid ${uploads.uploadsCovered ? 'var(--border)' : '#f59e0b55'}`,
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px 14px',
                  marginBottom: 20,
                  fontSize: '0.85rem',
                }}>
                  {uploads.uploadsCovered ? (
                    <>
                      <strong>Media is covered locally.</strong> Upload archives now exist on this server. Offsite backup is still recommended because DB and uploads backups are on the same machine.
                    </>
                  ) : (
                    <>
                      <strong>⚠ Media files need a backup.</strong> Run an upload backup to archive uploaded images and media in the <code>uploads/</code> directory.
                    </>
                  )}
                </div>

                {uploads.lastServiceLog && uploads.lastServiceLog !== 'unavailable' && (
                  <div style={{ marginBottom: 20 }}>
                    <strong style={{ display: 'block', marginBottom: 6, fontSize: '0.88rem' }}>Last uploads backup log</strong>
                    <pre style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: '0.75rem', overflowX: 'auto', maxHeight: 180, overflowY: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {uploads.lastServiceLog}
                    </pre>
                  </div>
                )}

                <div style={{ marginBottom: 24 }}>
                  <button className="btn btn-primary" disabled={uploadBackupRunning} onClick={runUploadBackupNow}>
                    {uploadBackupRunning ? '⏳ Running upload backup…' : '💾 Run Upload Backup Now'}
                  </button>
                  <span className="muted" style={{ marginLeft: 12, fontSize: '0.82rem' }}>
                    Runs <code>scripts/backup-uploads.sh</code> — archives media only, no restore.
                  </span>
                  {uploadBackupRunResult && (
                    <pre style={{ marginTop: 10, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: '0.75rem', overflowX: 'auto', maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {uploadBackupRunResult}
                    </pre>
                  )}
                </div>

                {/* ── Restore instructions (read-only) ── */}
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', fontSize: '0.84rem' }}>
                  <strong style={{ display: 'block', marginBottom: 10 }}>🔴 Restore Procedure — Manual Only</strong>
                  <p className="muted" style={{ marginBottom: 10 }}>
                    Restore requires stopping the service and copying backup files via SSH. There is no restore button.
                  </p>
                  <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
                    <li>Take safety snapshots first: <code>npm run backup:db</code> and <code>npm run backup:uploads</code></li>
                    <li>Stop the service: <code>sudo systemctl stop refugecloud</code></li>
                    <li>Keep a copy of the live DB: <code>cp data/social.db data/social.db.pre-restore</code></li>
                    <li><strong>Delete WAL sidecar files (critical):</strong> <code>rm -f data/social.db-wal data/social.db-shm</code></li>
                    <li>Copy the backup in: <code>cp /home/brock/backups/refugecloud-db/&lt;filename&gt;.db data/social.db</code></li>
                    <li>Restore uploads only from a verified archive: <code>tar -xzf /home/brock/backups/refugecloud-uploads/&lt;filename&gt;.tar.gz -C /home/brock/social-site</code></li>
                    <li>Verify: <code>sqlite3 data/social.db "PRAGMA integrity_check;"</code></li>
                    <li>Restart: <code>sudo systemctl start refugecloud</code></li>
                  </ol>
                  <p className="muted" style={{ marginTop: 10, fontSize: '0.8rem' }}>Full documentation: <code>docs/backups.md</code></p>
                </div>
              </>
            );
          })()}
        </div>
      )}

    </div>
  );
}
