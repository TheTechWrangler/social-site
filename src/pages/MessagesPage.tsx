import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';

const DM_MAX_LENGTH = 2000;

function Avatar({ user, size = 36 }: { user: any; size?: number }) {
  const name = user?.displayName || user?.display_name || user?.username || '?';
  if (user?.avatarUrl || user?.avatar_url) {
    return <img src={user.avatarUrl || user.avatar_url} alt="" className="avatar-img" style={{ width: size, height: size, borderRadius: '50%' }} />;
  }
  return (
    <div className="avatar-placeholder" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {name[0]}
    </div>
  );
}

export default function MessagesPage({ user: currentUser }: { user: any }) {
  const { conversationId: convIdParam } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(convIdParam ? Number(convIdParam) : null);
  const [messages, setMessages] = useState<any[]>([]);
  const [otherUser, setOtherUser] = useState<any>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'thread'>(convIdParam ? 'thread' : 'list');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadConversations();
  }, []);

  useEffect(() => {
    if (convIdParam) {
      const id = Number(convIdParam);
      setActiveConvId(id);
      setMobileView('thread');
      loadThread(id, true);
    }
  }, [convIdParam]);

  async function loadConversations() {
    setLoadingConvs(true);
    try {
      const r = await api.getConversations();
      setConversations(r.conversations || []);
    } catch (e) { console.error(e); }
    setLoadingConvs(false);
  }

  const loadThread = useCallback(async (id: number, fresh = false) => {
    setLoadingMsgs(true);
    setSendError('');
    try {
      const oldest = fresh ? undefined : (messages[0]?.id as number | undefined);
      const r = await api.getMessages(id, oldest);
      setOtherUser(r.otherUser);
      setHasMore(r.hasMore);
      if (fresh) {
        setMessages(r.messages);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'auto' }), 50);
      } else {
        setMessages(prev => [...r.messages, ...prev]);
      }
      await api.markConversationRead(id);
      setConversations(prev => prev.map(c =>
        c.id === id ? { ...c, unreadCount: 0 } : c
      ));
    } catch (e) { console.error(e); }
    setLoadingMsgs(false);
  }, [messages]);

  async function openConversation(id: number) {
    setMessages([]);
    setOtherUser(null);
    setHasMore(false);
    setSendError('');
    navigate(`/messages/${id}`);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || !activeConvId || sending) return;
    setSending(true);
    setSendError('');
    try {
      const r = await api.sendMessage(activeConvId, body.trim());
      setMessages(prev => [...prev, r.message]);
      setBody('');
      setConversations(prev => prev.map(c =>
        c.id === activeConvId ? { ...c, lastMessage: { ...r.message, senderId: currentUser.id } } : c
      ));
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
    } catch (e: any) {
      setSendError(e.message || 'Could not send message.');
    }
    setSending(false);
  }

  async function handleDelete(msgId: number) {
    if (!activeConvId) return;
    if (!confirm('Delete this message?')) return;
    try {
      await api.deleteMessage(activeConvId, msgId);
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, body: null, isDeleted: true } : m));
    } catch (e: any) { alert(e.message || 'Could not delete.'); }
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const canSend = otherUser && body.trim().length > 0 && !sending;

  return (
    <div className="messages-layout">
      {/* Conversation list */}
      <div className={`conv-list ${mobileView === 'thread' ? 'conv-list--hidden-mobile' : ''}`}>
        <div className="conv-list-header">
          <h3>Messages</h3>
        </div>
        {loadingConvs ? (
          <p className="muted" style={{ padding: '12px 16px' }}>Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="muted" style={{ padding: '12px 16px', fontSize: '0.88rem' }}>
            No conversations yet. Visit a profile to start one.
          </p>
        ) : (
          <div className="conv-list-items">
            {conversations.map(c => {
              const isActive = c.id === activeConvId;
              const hasUnread = c.unreadCount > 0;
              return (
                <button
                  key={c.id}
                  className={`conv-item ${isActive ? 'conv-item--active' : ''} ${hasUnread ? 'conv-item--unread' : ''}`}
                  onClick={() => openConversation(c.id)}
                >
                  <Avatar user={c.otherUser} size={38} />
                  <div className="conv-item-info">
                    <div className="conv-item-name">
                      <span>{c.otherUser?.displayName || c.otherUser?.username}</span>
                      {hasUnread && <span className="badge">{c.unreadCount}</span>}
                    </div>
                    <div className="conv-item-preview">
                      {c.lastMessage
                        ? (c.lastMessage.body === null ? <em>Message deleted</em> : c.lastMessage.body)
                        : <span className="muted">No messages yet</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Thread pane */}
      <div className={`conv-thread ${mobileView === 'list' ? 'conv-thread--hidden-mobile' : ''}`}>
        {!activeConvId ? (
          <div className="conv-thread-empty">
            <p className="muted">Select a conversation or <Link to="/friends">visit a friend's profile</Link> to start one.</p>
          </div>
        ) : (
          <>
            <div className="conv-thread-header">
              <button className="btn btn-ghost btn-sm conv-back-btn" onClick={() => { setMobileView('list'); navigate('/messages'); }}>
                ← Back
              </button>
              {otherUser && (
                <Link to={`/profile/${otherUser.username}`} className="conv-thread-title">
                  <Avatar user={otherUser} size={30} />
                  <span>{otherUser.displayName}</span>
                  <span className="muted" style={{ fontSize: '0.82rem' }}>@{otherUser.username}</span>
                </Link>
              )}
            </div>

            <div className="conv-messages">
              {hasMore && (
                <div style={{ textAlign: 'center', padding: '8px 0' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => loadThread(activeConvId, false)} disabled={loadingMsgs}>
                    {loadingMsgs ? 'Loading…' : 'Load older messages'}
                  </button>
                </div>
              )}

              {messages.length === 0 && !loadingMsgs && (
                <p className="muted" style={{ textAlign: 'center', padding: '24px 0', fontSize: '0.88rem' }}>
                  No messages yet. Say hello!
                </p>
              )}

              {messages.map(m => {
                const isOwn = m.senderId === currentUser.id;
                return (
                  <div key={m.id} className={`msg-row ${isOwn ? 'msg-row--own' : 'msg-row--theirs'}`}>
                    {!isOwn && <Avatar user={otherUser} size={28} />}
                    <div className={`msg-bubble ${isOwn ? 'msg-bubble--own' : 'msg-bubble--theirs'} ${m.isDeleted ? 'msg-bubble--deleted' : ''}`}>
                      {m.isDeleted
                        ? <em className="muted">Message deleted</em>
                        : <span>{m.body}</span>}
                      <div className="msg-meta">
                        <span className="msg-time">{formatTime(m.createdAt)}</span>
                        {isOwn && !m.isDeleted && (
                          <button className="msg-delete-btn" onClick={() => handleDelete(m.id)} title="Delete message">×</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            <form className="conv-composer" onSubmit={handleSend}>
              {sendError && <p className="conv-send-error">{sendError}</p>}
              <div className="conv-composer-row">
                <textarea
                  ref={textareaRef}
                  className="input conv-composer-input"
                  placeholder="Write a message…"
                  value={body}
                  maxLength={DM_MAX_LENGTH}
                  rows={2}
                  onChange={e => { setBody(e.target.value); setSendError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (canSend) handleSend(e as any); } }}
                />
                <button type="submit" className="btn btn-primary" disabled={!canSend}>
                  {sending ? '…' : 'Send'}
                </button>
              </div>
              {body.length > DM_MAX_LENGTH * 0.9 && (
                <p className="muted" style={{ fontSize: '0.78rem', textAlign: 'right' }}>
                  {body.length}/{DM_MAX_LENGTH}
                </p>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
}
