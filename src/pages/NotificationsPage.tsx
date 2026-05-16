import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface Notif {
  id: number;
  type: string;
  read: number;
  post_id: number | null;
  post_parent_id: number | null;
  group_id: number | null;
  actor_username: string;
  actor_name: string;
  post_snippet: string | null;
  created_at: string;
}

interface Props {
  onMarkAllRead: () => void;
  onMarkOneRead: () => void;
}

function notifLabel(n: Notif): string {
  switch (n.type) {
    case 'follow':      return `@${n.actor_username} followed you`;
    case 'like':        return `@${n.actor_username} reacted to your post`;
    case 'comment':     return `@${n.actor_username} commented on your post`;
    case 'repost':      return `@${n.actor_username} reposted your post`;
    case 'group_invite':return `@${n.actor_username} invited you to a group`;
    default:            return `@${n.actor_username} — ${n.type}`;
  }
}

function notifDest(n: Notif): string {
  switch (n.type) {
    case 'follow':
      return `/profile/${n.actor_username}`;
    case 'like':
    case 'repost':
      return n.post_id ? `/posts/${n.post_id}` : `/profile/${n.actor_username}`;
    case 'comment':
      // post_id is the comment row; post_parent_id is the post being commented on
      return n.post_parent_id
        ? `/posts/${n.post_parent_id}`
        : n.post_id
          ? `/posts/${n.post_id}`
          : `/profile/${n.actor_username}`;
    case 'group_invite':
      return n.group_id ? `/groups/${n.group_id}` : '/';
    default:
      return '/';
  }
}

export default function NotificationsPage({ onMarkAllRead, onMarkOneRead }: Props) {
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    api.getNotifications().then(r => setNotifs(r.notifications)).catch(() => {});
  }, []);

  const hasUnread = notifs.some(n => !n.read);

  async function handleMarkAllRead() {
    setMarking(true);
    try {
      await api.readAll();
      setNotifs(prev => prev.map(n => ({ ...n, read: 1 })));
      onMarkAllRead();
    } catch {
      // badge self-corrects on next poll
    } finally {
      setMarking(false);
    }
  }

  function handleNotifClick(n: Notif) {
    if (!n.read) {
      api.markNotificationRead(n.id).catch(() => {});
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: 1 } : x));
      onMarkOneRead();
    }
  }

  return (
    <div className="notifications-page">
      <div className="notifications-header">
        <h2>Notifications</h2>
        {hasUnread && (
          <button className="btn btn-sm" onClick={handleMarkAllRead} disabled={marking}>
            {marking ? 'Marking…' : 'Mark all read'}
          </button>
        )}
      </div>
      {notifs.length === 0 ? (
        <p className="muted">No notifications yet.</p>
      ) : (
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
      )}
    </div>
  );
}
