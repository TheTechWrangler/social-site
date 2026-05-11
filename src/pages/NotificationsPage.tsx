import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

const TYPE_LABELS: Record<string, string> = {
  follow: 'followed you',
  like: 'liked your post',
  comment: 'commented on your post',
  repost: 'reposted your post',
  group_invite: 'invited you to a group',
};

interface Props {
  onMarkAllRead: () => void;
}

export default function NotificationsPage({ onMarkAllRead }: Props) {
  const [notifs, setNotifs] = useState<any[]>([]);
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
      // silent — badge will self-correct on next poll
    } finally {
      setMarking(false);
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
          <div key={n.id} className={`notification ${n.read ? '' : 'unread'}`}>
            <Link to={`/profile/${n.actor_username}`}><strong>{n.actor_name}</strong></Link>
            {' '}{TYPE_LABELS[n.type] || n.type}
            <span className="muted time">{new Date(n.created_at + 'Z').toLocaleString()}</span>
          </div>
        ))
      )}
    </div>
  );
}
