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

export default function NotificationsPage() {
  const [notifs, setNotifs] = useState<any[]>([]);

  useEffect(() => {
    api.getNotifications().then(r => setNotifs(r.notifications)).catch(() => {});
    api.readAll().catch(() => {});
  }, []);

  return (
    <div className="notifications-page">
      <h2>Notifications</h2>
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
