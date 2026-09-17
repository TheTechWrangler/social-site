import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, type NotificationDto } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';

interface Props {
  onMarkAllRead: () => void;
  onMarkOneRead: () => void;
}

function notifLabel(n: NotificationDto): string {
  switch (n.type) {
    case 'follow':      return `@${n.actor_username} followed you`;
    case 'like':        return `@${n.actor_username} reacted to your post`;
    case 'comment':     return `@${n.actor_username} ${n.comment_kind === 'reply' ? 'replied to your comment' : 'commented on your post'}`;
    case 'repost':      return `@${n.actor_username} reposted your post`;
    case 'group_invite':return `@${n.actor_username} invited you to a group`;
    default:            return `@${n.actor_username} — ${n.type}`;
  }
}

function notifDest(n: NotificationDto): string {
  switch (n.type) {
    case 'follow':
      return `/profile/${n.actor_username}`;
    case 'like':
    case 'repost':
      return n.post_id ? `/posts/${n.post_id}` : `/profile/${n.actor_username}`;
    case 'comment':
      return n.post_id ? `/posts/${n.post_id}` : `/profile/${n.actor_username}`;
    case 'group_invite':
      return n.group_id ? `/groups/${n.group_id}` : '/';
    default:
      return '/';
  }
}

export default function NotificationsPage({ onMarkAllRead, onMarkOneRead }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const gate = useRef(new RouteRequestGate());
  const [notifs, setNotifs] = useState<NotificationDto[]>([]);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState('');

  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  async function loadNotifications() {
    const isCurrent = gate.current.begin();
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.getNotifications();
      if (!isCurrent()) return;
      setNotifs(result.notifications);
      setCursor(result.nextCursor ?? null);
      setLoaded(true);
    } catch {
      if (isCurrent()) setLoadError(loaded ? 'Could not refresh notifications. Previously loaded notifications may be stale.' : 'Could not load notifications.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }
  useEffect(() => {
    void loadNotifications();
    return () => gate.current.invalidate();
  }, []);
  async function loadMore() {
    if (!cursor || loading || marking) return;
    setLoading(true);
    try {
      const result = await api.getNotifications(cursor);
      setNotifs(previous => [...previous, ...result.notifications.filter(n => !previous.some(known => known.id === n.id))]);
    setMarkError('');
      setCursor(result.nextCursor ?? null);
    } catch { setMarkError('Could not load notifications.'); }
    finally { setLoading(false); }
  }

  const hasUnread = notifs.some(n => !n.read);

  async function handleMarkAllRead() {
    setMarking(true);
    setMarkError('');
    try {
      await api.readAll();
      setNotifs(prev => prev.map(n => ({ ...n, read: 1 })));
      onMarkAllRead();
    } catch (e: any) {
      setMarkError(e.message || 'Could not mark notifications as read.');
    } finally {
      setMarking(false);
    }
  }

  function handleNotifClick(n: NotificationDto) {
    if (!n.read) {
      void api.markNotificationRead(n.id).then(result => {
        setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: 1 } : x));
        if (result.changed) onMarkOneRead();
      }).catch((e: any) => {
        setMarkError(e.message || 'Could not mark notification as read.');
      });
    }
  }

  return (
    <div className="notifications-page">
      <div className="notifications-header">
        <h2>Notifications</h2>
        {hasUnread && (
          <button className="btn btn-sm" onClick={handleMarkAllRead} disabled={marking || loading}>
            {marking ? 'Marking…' : 'Mark all read'}
          </button>
        )}
      </div>
      {cursor && <button className="btn btn-ghost" disabled={loading || marking} onClick={() => void loadMore()}>{loading ? 'Loading more notifications…' : 'Load more notifications'}</button>}
      {markError && <p className="error-msg" role="alert">{markError}</p>}
      {loadError && <div className="error-msg" role="alert">{loadError}{' '}<button className="btn btn-sm" onClick={() => void loadNotifications()}>Retry</button></div>}
      {loading && !loaded && <p className="muted">Loading notifications…</p>}
      {loaded && notifs.length === 0 ? (
        <p className="muted">No notifications yet.</p>
      ) : loaded ? (
        notifs.map(n => (
          <Link
            key={n.id}
            to={notifDest(n)}
            className={`notification notification-link ${n.read ? '' : 'unread'}`}
            onClick={() => handleNotifClick(n)}
          >
            <span className="notif-text">{notifLabel(n)}</span>
            {n.post_snippet && <span className="notif-snippet">"{n.post_snippet.slice(0, 80)}{n.post_snippet.length > 80 ? '…' : ''}"</span>}
            <span className="muted time">{new Date(n.created_at + 'Z').toLocaleString()}</span>
          </Link>
        ))
      ) : null}
    </div>
  );
}
