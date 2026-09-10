import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';
import {
  clearConversationUnread,
  highestObservedMessageId,
  mergeMessages,
  reconcileConversationPreview,
  setConversationDraft,
} from '../messageState';

const DM_MAX_LENGTH = 2000;
export const MESSAGE_POLL_INTERVAL_MS = 8000;

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

function conversationIdFromParam(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export default function MessagesPage({
  user: currentUser,
  onUnreadChange,
}: {
  user: any;
  onUnreadChange?: (count: number) => void;
}) {
  const { conversationId: convIdParam } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const accountId = Number(currentUser?.id);
  const activeConvId = conversationIdFromParam(convIdParam);
  const activeThreadKey = accountId + ':' + (activeConvId ?? '');
  const currentAccountId = useRef(accountId);
  currentAccountId.current = accountId;
  const currentThreadKey = useRef(activeThreadKey);
  currentThreadKey.current = activeThreadKey;

  const [conversations, setConversations] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [observedThrough, setObservedThrough] = useState<number | null>(null);
  const messagesRef = useRef<any[]>([]);
  messagesRef.current = messages;
  const [otherUser, setOtherUser] = useState<any>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sendingByConversation, setSendingByConversation] = useState<Record<number, boolean>>({});
  const sendingInFlight = useRef(new Set<number>());
  const [sendError, setSendError] = useState('');
  const [threadError, setThreadError] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'thread'>(activeConvId ? 'thread' : 'list');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationGate = useRef(new RouteRequestGate());
  const threadGate = useRef(new RouteRequestGate());
  const olderGate = useRef(new RouteRequestGate());
  const readGate = useRef(new RouteRequestGate());
  const pollInFlight = useRef<string | null>(null);
  const lastReadAttempt = useRef<Record<string, number>>({});

  const body = activeConvId ? (drafts[activeConvId] || '') : '';
  const sending = activeConvId ? !!sendingByConversation[activeConvId] : false;

  useEffect(() => {
    conversationGate.current.invalidate();
    threadGate.current.invalidate();
    olderGate.current.invalidate();
    readGate.current.invalidate();
    pollInFlight.current = null;
    lastReadAttempt.current = {};
    setConversations([]);
    setMessages([]);
    setObservedThrough(null);
    setOtherUser(null);
    setHasMore(false);
    setDrafts({});
    setSendingByConversation({});
    sendingInFlight.current.clear();
    setSendError('');
    setThreadError('');
    setLoadingConvs(true);
    void loadConversations(accountId, true);
    return () => {
      conversationGate.current.invalidate();
      threadGate.current.invalidate();
      olderGate.current.invalidate();
      readGate.current.invalidate();
    };
  }, [accountId]);

  useEffect(() => {
    threadGate.current.invalidate();
    olderGate.current.invalidate();
    readGate.current.invalidate();
    pollInFlight.current = null;
    setMessages([]);
    setObservedThrough(null);
    setOtherUser(null);
    setHasMore(false);
    setLoadingMsgs(false);
    setLoadingOlder(false);
    setSendError('');
    setThreadError('');
    if (activeConvId) {
      setMobileView('thread');
      void loadLatestThread(activeConvId, accountId, 'initial');
    } else {
      setMobileView('list');
    }
    return () => {
      threadGate.current.invalidate();
      olderGate.current.invalidate();
      readGate.current.invalidate();
    };
  }, [activeThreadKey]);

  useEffect(() => {
    if (!activeConvId) return;
    const conversationId = activeConvId;
    const viewerId = accountId;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || pollInFlight.current) return;
      void loadLatestThread(conversationId, viewerId, 'poll');
    }, MESSAGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeThreadKey]);

  useEffect(() => {
    if (!activeConvId) return;
    const observedMessageId = observedThrough;
    if (observedMessageId === null) return;
    const requestKey = activeThreadKey;
    if ((lastReadAttempt.current[requestKey] || 0) >= observedMessageId) return;
    lastReadAttempt.current[requestKey] = observedMessageId;
    const isCurrent = readGate.current.begin();
    void api.markConversationRead(activeConvId, observedMessageId)
      .then(() => {
        if (!isCurrent() || currentThreadKey.current !== requestKey) return;
        setConversations(previous => clearConversationUnread(previous, activeConvId));
        void loadConversations(accountId, false);
      })
      .catch(() => {
        if (isCurrent() && currentThreadKey.current === requestKey) {
          lastReadAttempt.current[requestKey] = Math.min(
            lastReadAttempt.current[requestKey] || observedMessageId,
            observedMessageId - 1,
          );
        }
      });
  }, [observedThrough, activeThreadKey]);

  async function loadConversations(viewerId = accountId, showLoading = false) {
    const isCurrent = conversationGate.current.begin();
    if (showLoading) setLoadingConvs(true);
    try {
      const response = await api.getConversations();
      if (!isCurrent() || currentAccountId.current !== viewerId) return;
      const next = response.conversations || [];
      setConversations(next);
      onUnreadChange?.(next.filter((conversation: any) => conversation.unreadCount > 0).length);
    } catch (error) {
      if (isCurrent() && currentAccountId.current === viewerId) console.error(error);
    } finally {
      if (isCurrent() && currentAccountId.current === viewerId) setLoadingConvs(false);
    }
  }

  async function loadLatestThread(id: number, viewerId: number, mode: 'initial' | 'poll' | 'refresh') {
    const requestKey = viewerId + ':' + id;
    if (mode === 'poll') pollInFlight.current = requestKey;
    const isCurrent = threadGate.current.begin();
    if (mode === 'initial') setLoadingMsgs(true);
    setThreadError('');
    try {
      const response = await api.getMessages(id);
      if (!isCurrent() || currentThreadKey.current !== requestKey) return;
      setOtherUser(response.otherUser);
      if (mode === 'initial') setHasMore(response.hasMore);
      setObservedThrough(highestObservedMessageId(response.messages));
      setMessages(previous => mode === 'initial'
        ? response.messages
        : mergeMessages(previous, response.messages));
      if (mode === 'initial') {
        window.setTimeout(() => {
          if (currentThreadKey.current === requestKey) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
        }, 50);
      }
      void loadConversations(viewerId, false);
    } catch (error: any) {
      if (isCurrent() && currentThreadKey.current === requestKey) {
        console.error(error);
        setThreadError(error.message || 'Could not load this conversation.');
      }
    } finally {
      if (isCurrent() && currentThreadKey.current === requestKey) setLoadingMsgs(false);
      if (mode === 'poll' && pollInFlight.current === requestKey) pollInFlight.current = null;
    }
  }

  async function loadOlderMessages() {
    if (!activeConvId || loadingOlder) return;
    const id = activeConvId;
    const requestKey = activeThreadKey;
    const oldest = messagesRef.current[0]?.id as number | undefined;
    if (!oldest) return;
    const isCurrent = olderGate.current.begin();
    setLoadingOlder(true);
    try {
      const response = await api.getMessages(id, oldest);
      if (!isCurrent() || currentThreadKey.current !== requestKey) return;
      setMessages(previous => mergeMessages(response.messages, previous));
      setHasMore(response.hasMore);
    } catch (error: any) {
      if (isCurrent() && currentThreadKey.current === requestKey) {
        setThreadError(error.message || 'Could not load older messages.');
      }
    } finally {
      if (isCurrent() && currentThreadKey.current === requestKey) setLoadingOlder(false);
    }
  }

  function openConversation(id: number) {
    setMobileView('thread');
    if (id === activeConvId) {
      void loadLatestThread(id, accountId, 'refresh');
      return;
    }
    navigate('/messages/' + id);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!activeConvId || sending || sendingInFlight.current.has(activeConvId)) return;
    const targetConversationId = activeConvId;
    const targetAccountId = accountId;
    const targetThreadKey = activeThreadKey;
    const submittedBody = body.trim();
    if (!submittedBody) return;
    sendingInFlight.current.add(targetConversationId);
    setSendingByConversation(previous => ({ ...previous, [targetConversationId]: true }));
    setSendError('');
    try {
      const response = await api.sendMessage(targetConversationId, submittedBody);
      if (currentAccountId.current !== targetAccountId) return;
      setDrafts(previous => previous[targetConversationId]?.trim() === submittedBody
        ? setConversationDraft(previous, targetConversationId, '')
        : previous);
      setConversations(previous => reconcileConversationPreview(
        previous,
        targetConversationId,
        response.message,
      ));
      if (currentThreadKey.current === targetThreadKey) {
        setMessages(previous => mergeMessages(previous, [response.message]));
        window.setTimeout(() => {
          if (currentThreadKey.current === targetThreadKey) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 30);
      }
      void loadConversations(targetAccountId, false);
    } catch (error: any) {
      if (currentThreadKey.current === targetThreadKey) {
        setSendError(error.message || 'Could not send message.');
      }
    } finally {
      sendingInFlight.current.delete(targetConversationId);
      if (currentAccountId.current === targetAccountId) {
        setSendingByConversation(previous => ({ ...previous, [targetConversationId]: false }));
      }
    }
  }

  async function handleDelete(msgId: number) {
    if (!activeConvId || !confirm('Delete this message?')) return;
    const targetConversationId = activeConvId;
    const targetAccountId = accountId;
    const targetThreadKey = activeThreadKey;
    try {
      const response = await api.deleteMessage(targetConversationId, msgId);
      if (currentAccountId.current !== targetAccountId) return;
      if (currentThreadKey.current === targetThreadKey) {
        setMessages(previous => previous.map(message => message.id === msgId
          ? { ...message, body: null, isDeleted: true }
          : message));
      }
      setConversations(previous => reconcileConversationPreview(
        previous,
        targetConversationId,
        response.lastMessage || null,
      ));
      void loadConversations(targetAccountId, false);
    } catch (error: any) {
      if (currentThreadKey.current === targetThreadKey) alert(error.message || 'Could not delete.');
    }
  }

  function formatTime(iso: string) {
    const date = new Date(iso);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
      + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const canSend = otherUser && body.trim().length > 0 && !sending;

  return (
    <div className="messages-layout">
      <div className={`conv-list ${mobileView === 'thread' ? 'conv-list--hidden-mobile' : ''}`}>
        <div className="conv-list-header"><h3>Messages</h3></div>
        {loadingConvs ? (
          <p className="muted" style={{ padding: '12px 16px' }}>Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="muted" style={{ padding: '12px 16px', fontSize: '0.88rem' }}>
            No conversations yet. Visit a profile to start one.
          </p>
        ) : (
          <div className="conv-list-items">
            {conversations.map(conversation => {
              const isActive = conversation.id === activeConvId;
              const hasUnread = conversation.unreadCount > 0;
              return (
                <button
                  key={conversation.id}
                  className={`conv-item ${isActive ? 'conv-item--active' : ''} ${hasUnread ? 'conv-item--unread' : ''}`}
                  onClick={() => openConversation(conversation.id)}
                >
                  <Avatar user={conversation.otherUser} size={38} />
                  <div className="conv-item-info">
                    <div className="conv-item-name">
                      <span>{conversation.otherUser?.displayName || conversation.otherUser?.username}</span>
                      {hasUnread && <span className="badge">{conversation.unreadCount}</span>}
                    </div>
                    <div className="conv-item-preview">
                      {conversation.lastMessage
                        ? conversation.lastMessage.body
                        : <span className="muted">No messages yet</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

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
                  <button className="btn btn-ghost btn-sm" onClick={loadOlderMessages} disabled={loadingOlder}>
                    {loadingOlder ? 'Loading…' : 'Load older messages'}
                  </button>
                </div>
              )}
              {threadError && (
                <div style={{ textAlign: 'center' }}>
                  <p className="error-msg" role="alert">{threadError}</p>
                  <button className="btn btn-ghost btn-sm" onClick={() => loadLatestThread(activeConvId, accountId, 'refresh')}>Try again</button>
                </div>
              )}
              {messages.length === 0 && !loadingMsgs && !threadError && (
                <p className="muted" style={{ textAlign: 'center', padding: '24px 0', fontSize: '0.88rem' }}>
                  No messages yet. Say hello!
                </p>
              )}
              {messages.map(message => {
                const isOwn = message.senderId === currentUser.id;
                return (
                  <div key={message.id} className={`msg-row ${isOwn ? 'msg-row--own' : 'msg-row--theirs'}`}>
                    {!isOwn && <Avatar user={otherUser} size={28} />}
                    <div className={`msg-bubble ${isOwn ? 'msg-bubble--own' : 'msg-bubble--theirs'} ${message.isDeleted ? 'msg-bubble--deleted' : ''}`}>
                      {message.isDeleted ? <em className="muted">Message deleted</em> : <span>{message.body}</span>}
                      <div className="msg-meta">
                        <span className="msg-time">{formatTime(message.createdAt)}</span>
                        {isOwn && !message.isDeleted && (
                          <button className="msg-delete-btn" onClick={() => handleDelete(message.id)} title="Delete message">×</button>
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
                  onChange={event => {
                    setDrafts(previous => setConversationDraft(previous, activeConvId, event.target.value));
                    setSendError('');
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      if (canSend) void handleSend(event as any);
                    }
                  }}
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
